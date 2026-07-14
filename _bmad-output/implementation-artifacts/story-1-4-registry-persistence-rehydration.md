# Story 1.4: Registry Persistence & Rehydration

Status: ready-for-dev

**Prerequisite:** Story 1.3 complete (`ProjectRegistry`, registry MCP tools, CLI `init`/`register`, all `done`). Do not restructure the repo.

<!-- Implemented by a local model (qwen3-coder-next). Instructions are literal and copy-paste ready
     ON PURPOSE. Follow them exactly; do not infer or add scope. Read CLAUDE.md first — especially
     "Dependencies & install config (do NOT touch...)". This story adds NO dependencies and changes
     NO dependency/lockfile/.npmrc/pnpm config. If a build error smells dependency-related, STOP and
     hand back to the orchestrator; do not thrash. -->

## Story

As an AI agent,
I want registered projects to survive daemon restarts,
so that intelligence and registrations accumulate across sessions.

## Acceptance Criteria

1. **Rehydrate on start.** When the daemon starts, it loads the registered-project set from `~/.test-mcp/registry.json` (via `TEST_MCP_HOME` in tests) so previously registered projects are addressable immediately, without re-registering. (epics §1.4 AC1; architecture §Data Model, §Process & Deployment Topology)
2. **Versioned persistence.** Every persisted registry/config file carries a numeric `schemaVersion` (= `SCHEMA_VERSION`). (epics §1.4 AC2) — `config.json` and `registry.json` already do; this story adds a guard/tests and must not regress it.
3. **Migrate or fail clean.** When `registry.json` has an older `schemaVersion`, the daemon migrates it forward (and re-persists the upgraded file); when it has a newer/unsupported version or is corrupt, the daemon reports a clear, **non-crashing** error and continues serving with an empty registry. (epics §1.4 AC3; architecture §Invariants (5) correctness-over-cleverness, §Error Taxonomy)

## Toolchain (from docs/project-context.md and CLAUDE.md — MUST follow)

- **pnpm only.** `pnpm run typecheck`, `pnpm run build`, `pnpm test`. Never `npm`/`yarn`. **Do NOT touch** `package.json` deps, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, or `.npmrc`.
- **ESM + NodeNext:** relative imports in `src/**` use the `.js` extension in the specifier; test imports use the `.ts` extension on relative source paths.
- Node 20+, `strict` TypeScript. **No new dependencies.**

## Scope boundaries (do NOT overstep)

- **Files you may create/modify — and ONLY these:**
  - `src/registry/project-registry.ts` — enhance `load()` with schemaVersion validation + migration; add the `migrateRegistryFile` helper (see Task 1).
  - `src/daemon/index.ts` — call `await registry.load()` (wrapped so a bad file cannot crash the daemon) in `startDaemon()` (see Task 2).
  - `test/registry-migration.test.ts`, `test/registry-rehydration.test.ts` — new.
- **Do NOT touch:** the registry tool handlers in `src/mcp/server.ts`, the CLI, `src/types/*`, the scaffold layout, `package.json`, `tsconfig.json`, `vitest.config.ts`, or the existing tests (add new test files; do not edit `test/project-registry.test.ts`).
- **Not in this story:** any change to registration behaviour, tool surface, or test execution. This is purely load-on-start + version handling.

## Verified facts to build on (current code, post-1.3)

- `src/index.ts` exports `SCHEMA_VERSION = 1`.
- `src/registry/project-registry.ts` already has: `ProjectRegistry(registryPath)`, `has`, `save()` (writes `{ schemaVersion: SCHEMA_VERSION, projects }` at mode `0o600`), `register`/`list`/`unregister`, and a `load()` that currently reads+parses `registry.json` and loads `parsed.projects` **without checking `schemaVersion`**. `RegistryError(code, message)` and the `RegistryFile` interface (`{ schemaVersion: number; projects: Record<string, { path; configPath; status }> }`) already exist. You are hardening `load()`.
- `src/daemon/index.ts` `startDaemon()` does (around line 133): `const registry = new ProjectRegistry(registryPath());` then `const server = http.createServer(createMcpRequestListener({ token, registry }));`. It does **not** call `registry.load()` yet. `registryPath()` and `centralDir()` are exported. The daemon must never crash on a bad file (invariant 5).
- `src/daemon/index.ts` `loadOrCreateConfig()` already validates `config.json`'s `schemaVersion` and writes `schemaVersion: SCHEMA_VERSION` — leave it as-is (AC2 already met for config).
- Daemon tests are hermetic: set `process.env.TEST_MCP_HOME` to a temp dir, seed `config.json` with `port: 0`, and always `await handle.close()` in teardown. The HTTP-client pattern is in `test/mcp-http.test.ts` (copy it).

## Tasks / Subtasks

### Task 1 — Version-aware `load()` + migration helper (AC: 1,3)

In `src/registry/project-registry.ts`:

1. Add this module-level helper (place it just above the `export class ProjectRegistry` line, below the `RegistryFile` interface):

```ts
/**
 * Validate and, if needed, upgrade a parsed registry file to the current schemaVersion.
 * Returns the current-version file plus an `upgraded` flag so the caller can re-persist.
 * Throws RegistryError (never crashes the daemon) on a newer/unsupported version.
 *
 * Add real step migrations here as SCHEMA_VERSION grows, e.g.:
 *   if (version < 2) { ...transform projects...; version = 2; }
 * Today SCHEMA_VERSION === 1, so the only "older" case is a pre-versioning file
 * (missing/0 schemaVersion), which is stamped forward with its projects intact.
 */
function migrateRegistryFile(
  parsed: unknown,
  registryPath: string,
): RegistryFile & { upgraded: boolean } {
  if (typeof parsed !== "object" || parsed === null) {
    throw new RegistryError("InvalidConfig", `registry.json is malformed at ${registryPath}`);
  }
  const obj = parsed as { schemaVersion?: unknown; projects?: unknown };
  const version = typeof obj.schemaVersion === "number" ? obj.schemaVersion : 0;

  if (version > SCHEMA_VERSION) {
    throw new RegistryError(
      "InvalidConfig",
      `registry.json schemaVersion ${version} is newer than supported ${SCHEMA_VERSION}; upgrade test-mcp`,
    );
  }

  const projects = (obj.projects ?? {}) as RegistryFile["projects"];
  return { schemaVersion: SCHEMA_VERSION, projects, upgraded: version < SCHEMA_VERSION };
}
```

2. Replace the existing `load()` method body with:

```ts
  /** Rehydrate the in-memory registry from registry.json. Migrates older files forward and
   *  re-persists them; throws RegistryError on a corrupt/newer file (the daemon catches it). */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.registryPath, "utf8");
    } catch {
      return; // no file yet — nothing to rehydrate
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RegistryError("InvalidConfig", `registry.json is not valid JSON at ${this.registryPath}`);
    }

    const file = migrateRegistryFile(parsed, this.registryPath);

    this.projects.clear();
    for (const [projectId, entry] of Object.entries(file.projects)) {
      this.projects.set(projectId, { projectId, ...entry });
    }

    if (file.upgraded) await this.save(); // persist the upgraded file at current schemaVersion
  }
```

(Do not change `save()`, `register()`, `list()`, `unregister()`, `has()`, or the exported functions.)

### Task 2 — Rehydrate on daemon start, without crashing (AC: 1,3)

In `src/daemon/index.ts` `startDaemon()`, change the registry instantiation (currently one line) to load the file, catching any error so a bad `registry.json` can never take the daemon down:

```ts
  const registry = new ProjectRegistry(registryPath());
  try {
    await registry.load();
  } catch (err) {
    process.stderr.write(
      `test-mcp daemon: could not load registry (${(err as Error).message}); ` +
        `starting with an empty registry\n`,
    );
  }
  const server = http.createServer(createMcpRequestListener({ token, registry }));
```

(Logging goes to **stderr** — never stdout, per CLAUDE.md. Nothing else in `startDaemon` changes.)

### Task 3 — Migration unit tests (AC: 2,3)

Create `test/registry-migration.test.ts`:

```ts
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectRegistry, RegistryError } from "../src/registry/project-registry.ts";

let tmp: string;
let registryFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-mig-"));
  registryFile = path.join(tmp, "registry.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const entry = { path: "/some/project", configPath: "/some/project/vitest.config.ts", status: "idle" };

describe("registry migration + rehydration", () => {
  it("loads a current-version file", async () => {
    fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, projects: { abc: entry } }));
    const reg = new ProjectRegistry(registryFile);
    await reg.load();
    expect(reg.has("abc")).toBe(true);
    expect(await reg.list()).toHaveLength(1);
  });

  it("migrates a legacy (pre-versioning) file forward and re-persists it", async () => {
    // No schemaVersion field => treated as version 0 and stamped to current.
    fs.writeFileSync(registryFile, JSON.stringify({ projects: { abc: entry } }));
    const reg = new ProjectRegistry(registryFile);
    await reg.load();
    expect(reg.has("abc")).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    expect(onDisk.schemaVersion).toBe(1); // upgraded file was re-saved
  });

  it("rejects a newer schemaVersion with a clear InvalidConfig error", async () => {
    fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 99, projects: {} }));
    const reg = new ProjectRegistry(registryFile);
    await expect(reg.load()).rejects.toMatchObject({ code: "InvalidConfig" });
    await expect(reg.load()).rejects.toBeInstanceOf(RegistryError);
  });

  it("rejects a corrupt (non-JSON) file with InvalidConfig", async () => {
    fs.writeFileSync(registryFile, "{ this is not json");
    const reg = new ProjectRegistry(registryFile);
    await expect(reg.load()).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  it("is a no-op when no registry file exists", async () => {
    const reg = new ProjectRegistry(registryFile);
    await expect(reg.load()).resolves.toBeUndefined();
    expect(await reg.list()).toHaveLength(0);
  });
});
```

### Task 4 — Daemon rehydration integration test (AC: 1,3)

Create `test/registry-rehydration.test.ts`. This seeds `registry.json` in a temp `TEST_MCP_HOME`, starts a real daemon, and confirms the project is served over MCP without re-registering. It also confirms a corrupt file does not crash the daemon.

```ts
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDaemon, type DaemonHandle } from "../src/daemon/index.ts";

let home: string;
let handle: DaemonHandle | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-rehydrate-"));
  process.env.TEST_MCP_HOME = home;
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ schemaVersion: 1, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }),
  );
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  delete process.env.TEST_MCP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function listProjectIds(h: DaemonHandle): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${h.token}` } },
  });
  const client = new Client({ name: "rehydrate-test", version: "0.0.0" });
  await client.connect(transport);
  const res = (await client.callTool({ name: "list_projects", arguments: {} })) as {
    content: Array<{ text: string }>;
  };
  await client.close();
  const { projects } = JSON.parse(res.content[0].text) as { projects: Array<{ projectId: string }> };
  return projects.map((p) => p.projectId);
}

function healthStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: "/", headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("daemon registry rehydration", () => {
  it("rehydrates registered projects from registry.json on start", async () => {
    fs.writeFileSync(
      path.join(home, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: {
          seed123: { path: "/tmp/seeded", configPath: "/tmp/seeded/vitest.config.ts", status: "idle" },
        },
      }),
    );
    handle = await startDaemon();
    expect(await listProjectIds(handle)).toContain("seed123");
  });

  it("starts with an empty registry (no crash) when registry.json is corrupt", async () => {
    fs.writeFileSync(path.join(home, "registry.json"), "{ not json");
    handle = await startDaemon();
    expect(await healthStatus(handle.port)).toBe(200);
    expect(await listProjectIds(handle)).toHaveLength(0);
  });
});
```

### Task 5 — Verify (AC: all)

- [ ] `pnpm run typecheck` → exit 0
- [ ] `pnpm run build` → exit 0
- [ ] `pnpm test` → all tests pass (existing + `registry-migration` + `registry-rehydration`)
- [ ] Manual (optional): `H=$(mktemp -d); TEST_MCP_HOME=$H node bin/test-mcp.mjs register` in this repo, then `TEST_MCP_HOME=$H node bin/test-mcp.mjs stop`, then `TEST_MCP_HOME=$H node bin/test-mcp.mjs start &` and `TEST_MCP_HOME=$H node bin/test-mcp.mjs status` → `registered projects: 1` (survived restart). Stop the daemon afterwards.

## Dev Notes

### Architecture invariants that constrain this story
- **Correctness over cleverness (invariant 5):** an unreadable/newer registry is an operational fault, not a reason to crash. The daemon logs a clear error to stderr and starts empty; it never dies on a bad file. [Source: docs/architecture.md#Invariants (5)]
- **Schemas are versioned (invariant 6):** all persisted JSON carries `schemaVersion`; loaders migrate older versions forward or reject newer ones with a clear message. [Source: docs/architecture.md#Invariants (6), #Data Model]
- **Central registry is the source of truth for rehydration** — `~/.test-mcp/registry.json`; per-project `.test-mcp/` state stays repo-local. Do not read/write project state centrally. [Source: docs/architecture.md#Data Model, #Process & Deployment Topology]
- **stdout is reserved for stdio JSON-RPC** — daemon diagnostics go to stderr only. [Source: CLAUDE.md#Logging; docs/architecture.md]

### Why the migration path is a stub-with-a-hook today
`SCHEMA_VERSION` is `1`, so no real older on-disk version exists yet. The only genuinely "older" case is a pre-versioning file (missing `schemaVersion`), which `migrateRegistryFile` treats as version 0 and stamps forward with its `projects` intact. The `if (version < N)` structure is the extension point for real transforms when `SCHEMA_VERSION` grows — add steps there, don't rewrite the loader. This satisfies AC3's "migrates … older schemaVersion" with a testable path while keeping today's behaviour honest.

### Previous story intelligence
- **`load()` already existed (Story 1.3) but was never called on start** and did no version checking — 1.3 explicitly deferred daemon-start rehydration and migration to this story. You are (a) wiring the call and (b) hardening the method. [Story 1.3 Dev Notes §Scope reminders]
- **Hermetic daemon tests:** `TEST_MCP_HOME` + `port: 0` + always `await handle.close()` in teardown (a live server leaks and hangs the run). Copy the HTTP-client setup from `test/mcp-http.test.ts`. [Story 1.1/1.2/1.3]
- **Dependency trap (Story 1.2):** a build/typecheck error that smells like deps is NOT yours to fix by editing `package.json`/lockfile/`.npmrc`. This story adds no deps; if such an error appears, STOP and report. [Story 1.2 Debug Log; CLAUDE.md]
- `save()` writes mode `0o600`; the migration re-save inherits that — do not change it.

### Project Structure Notes
- `src/registry/project-registry.ts` and `src/daemon/index.ts` already exist; edit in place per the tasks. New tests go in `test/` (matches `vitest.config.ts` `include: ["test/**/*.test.ts"]`). No path changes, no new source files.

### Testing standards
- Vitest, `environment: node`. Migration cases are pure unit tests against `ProjectRegistry` with an injected temp `registry.json` path. Rehydration is an integration test: seed the file, `startDaemon()`, then query `list_projects` over an authenticated Streamable HTTP client and close it in teardown.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.4: Registry Persistence & Rehydration]
- [Source: docs/architecture.md#Invariants]
- [Source: docs/architecture.md#Data Model]
- [Source: docs/architecture.md#Process & Deployment Topology]
- [Source: docs/architecture.md#Error Taxonomy]
- [Source: docs/patterns.md#Project Registration & State Layout Pattern]
- [Source: docs/project-context.md]
- [Source: story-1-3-project-registration-via-test-mcp-register.md (ProjectRegistry.load/save; hermetic HTTP-client test pattern)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
