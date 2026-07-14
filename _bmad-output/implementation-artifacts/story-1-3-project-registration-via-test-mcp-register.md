# Story 1.3: Project Registration via `test-mcp register`

Status: ready-for-dev

**Prerequisite:** Story 1.2 complete (MCP server + secured HTTP transport, `done`). Do not restructure the repo.

<!-- This story is implemented by a local model (qwen3-coder-next). Instructions are literal and
     copy-paste ready ON PURPOSE. Follow them exactly. Do not infer, improvise, or add scope.
     Read CLAUDE.md first — especially "Dependencies & install config (do NOT touch...)". This story
     adds NO dependencies and changes NO dependency/lockfile/.npmrc/pnpm config. If anything looks
     like a dependency problem, STOP and hand back to the orchestrator; do not thrash. -->

## Story

As an AI agent,
I want to register a project (auto-booting the daemon if needed) and later list/unregister it,
so that one daemon can serve many projects addressed by `projectId`.

## Acceptance Criteria

1. **Repo-local config + gitignore on register.** `test-mcp register` (and `test-mcp init`) resolve the project's git root, create `<git-root>/.test-mcp/config.json` (`{ schemaVersion, projectId, stateDir }`, `projectId` = hash of the absolute git-root path) if absent, and add `.test-mcp/` to `<git-root>/.gitignore` if absent. Both are idempotent (re-running does not duplicate or overwrite an existing `projectId`). (epics §1.3 AC1; architecture §Data Model, §Execution Flows)
2. **Auto-boot then register.** When the daemon is not running, `test-mcp register` (without `--no-spawn`) auto-boots the singleton in the background, waits for readiness, then registers over MCP. With `--no-spawn`, if the daemon is not reachable it exits non-zero with a `DaemonUnavailable` message telling the user to start it. (epics §1.3 AC2; architecture §Process & Deployment Topology)
3. **register_project validates + persists.** `register_project` (CLI or MCP) validates that a vitest/vite config resolves at the path; on success it records `{ projectId, path, configPath, status: "idle" }` in the central registry (`~/.test-mcp/registry.json`, carrying `schemaVersion`) and returns `{ projectId, path, status }`. (epics §1.3 AC3; architecture §Data Model)
4. **Invalid config rejected.** `register_project` on a path with no resolvable vitest/vite config returns the `InvalidConfig` error envelope and does NOT register the project. (epics §1.3 AC4)
5. **List + unregister.** `list_projects` returns each registered `{ projectId, path, status }`; `unregister_project` removes a known project from the active registry (returns `{ projectId, removed: true }`), and on an unknown `projectId` returns the `UnknownProject` envelope. The project's `.test-mcp/` state is retained unless `purge: true` is passed. (epics §1.3 AC5)
6. **Status reflects registrations.** `test-mcp status` on a running daemon reports the registered-project count (read from `~/.test-mcp/registry.json`). (Story 1.1 AC3 now that a registry exists.)

## Toolchain (from docs/project-context.md and CLAUDE.md — MUST follow)

- **pnpm only.** `pnpm run typecheck`, `pnpm run build`, `pnpm test`. Never `npm`/`yarn`. **Do NOT touch** `package.json` deps, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, or `.npmrc` (see CLAUDE.md).
- **ESM + NodeNext:** relative imports in `src/**` use the `.js` extension in the specifier (e.g. `import { computeProjectId } from "../registry/project-registry.js";`); SDK subpaths carry `.js`.
- **Test imports** use the `.ts` extension on relative source paths (e.g. `../src/registry/project-registry.ts`).
- Node 20+, `strict` TypeScript. **No new dependencies** — everything needed (`@modelcontextprotocol/sdk` 1.12.1, `zod`, Node built-ins) is installed.

## Scope boundaries (do NOT overstep)

- **Files you may create/modify — and ONLY these:**
  - `src/registry/project-registry.ts` — implement (replaces the current stub).
  - `src/mcp/server.ts` — swap the `isProjectRegistered` dep for a `registry` dep and implement the three registry tool handlers (see Task 2). Do NOT change the HTTP listener/security code.
  - `src/daemon/index.ts` — instantiate the registry, pass it to the listener, and make `getDaemonStatus()` count projects from `registry.json` (see Task 3).
  - `src/cli/main.ts` — implement `init` and `register` (see Task 4).
  - `test/project-registry.test.ts`, `test/mcp-registry.test.ts`, `test/cli-register.test.ts` — new.
- **Do NOT touch:** `src/types/contracts.ts` (placeholder schemas stay), `src/worker/*`, `src/selection/*`, `src/orchestrator/*`, `package.json`, `tsconfig.json`, `vitest.config.ts`, the scaffold layout, or the Story 1.1/1.2 daemon/MCP logic beyond what each task specifies.
- **Not in this story:** actually running tests (`run_tests`/status/failure stay `NotImplemented` for a *registered* project — Epic 2+); daemon-start REHYDRATION of the registry and schemaVersion MIGRATION (Story 1.4). This story WRITES `registry.json`; loading it on daemon start is 1.4. A fresh daemon therefore starts with an empty in-memory registry — that is expected here.

## Verified facts to build on (current code, post-1.2)

- `src/mcp/server.ts` currently takes `McpServerDeps { isProjectRegistered?: (id) => boolean }` and every project-scoped handler calls `requireRegisteredProject(projectId)` (returns `UnknownProject` if not registered, else `NotImplemented`). `register_project`/`list_projects` currently return `NotImplemented`. You will replace the dep with a real registry.
- `src/daemon/index.ts` `startDaemon()` has `const token = crypto.randomBytes(32).toString("hex");` then `const server = http.createServer(createMcpRequestListener({ token }));`. It exports `centralDir()`, `configPath()`, `lockfilePath()`, `readLockfile()`, `isPidAlive()`, `startDaemon()`, `getDaemonStatus()`.
- `src/index.ts` exports `SCHEMA_VERSION = 1`.
- `src/types/errors.ts` exports `type ErrorCode` (includes `UnknownProject`, `InvalidConfig`, `DaemonUnavailable`, `NotImplemented`, `ValidationError`) and `toAppError(code, message, details?)`.
- The MCP client for the CLI: `Client` from `@modelcontextprotocol/sdk/client/index.js`; `StreamableHTTPClientTransport(url, { requestInit: { headers } })` from `@modelcontextprotocol/sdk/client/streamableHttp.js` (both used already in `test/mcp-http.test.ts` — copy that usage).
- This repo has a `vitest.config.ts`, so it is itself a valid registration target (dogfood).

## Tasks / Subtasks

### Task 1 — Implement the project registry (AC: 3,4,5)

Replace the entire contents of `src/registry/project-registry.ts` with:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SCHEMA_VERSION } from "../index.js";
import type { ErrorCode } from "../types/errors.js";

export type ProjectStatus = "idle" | "running" | "error";

export interface RegisteredProject {
  projectId: string;
  path: string;
  configPath: string;
  status: ProjectStatus;
}

export interface RegistrySummary {
  projectId: string;
  path: string;
  status: ProjectStatus;
}

/** Thrown for expected, structured failures the MCP layer maps to an error envelope. */
export class RegistryError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Deterministic projectId: first 16 hex chars of sha256(absolute path). */
export function computeProjectId(projectPath: string): string {
  const abs = path.resolve(projectPath);
  return crypto.createHash("sha256").update(abs).digest("hex").slice(0, 16);
}

const VITEST_CONFIG_NAMES = [
  "vitest.config.ts", "vitest.config.mts", "vitest.config.cts",
  "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs",
  "vite.config.ts", "vite.config.mts", "vite.config.cts",
  "vite.config.js", "vite.config.mjs", "vite.config.cjs",
];

/** Return the resolved vitest/vite config path, or throw InvalidConfig if none exists. */
export function resolveVitestConfig(projectPath: string): string {
  const abs = path.resolve(projectPath);
  for (const name of VITEST_CONFIG_NAMES) {
    const candidate = path.join(abs, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new RegistryError(
    "InvalidConfig",
    `No vitest/vite config found at ${abs} (looked for ${VITEST_CONFIG_NAMES.join(", ")})`,
  );
}

interface RegistryFile {
  schemaVersion: number;
  projects: Record<string, { path: string; configPath: string; status: ProjectStatus }>;
}

export class ProjectRegistry {
  private projects = new Map<string, RegisteredProject>();

  /** @param registryPath absolute path to registry.json (injected so tests stay hermetic). */
  constructor(private readonly registryPath: string) {}

  has(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  /** Read registry.json into memory if it exists. (Daemon-start rehydration is wired in Story 1.4.) */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.registryPath, "utf8");
    } catch {
      return; // no file yet
    }
    const parsed = JSON.parse(raw) as RegistryFile;
    this.projects.clear();
    for (const [projectId, entry] of Object.entries(parsed.projects ?? {})) {
      this.projects.set(projectId, { projectId, ...entry });
    }
  }

  async save(): Promise<void> {
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const file: RegistryFile = { schemaVersion: SCHEMA_VERSION, projects: {} };
    for (const [projectId, p] of this.projects) {
      file.projects[projectId] = { path: p.path, configPath: p.configPath, status: p.status };
    }
    fs.writeFileSync(this.registryPath, JSON.stringify(file, null, 2));
  }

  /** Validate the path has a vitest/vite config, record it, persist, and return a summary. */
  async register(projectPath: string): Promise<RegistrySummary> {
    const abs = path.resolve(projectPath);
    const configPath = resolveVitestConfig(abs); // throws InvalidConfig if none

    // Prefer the projectId written by `test-mcp init/register` into the repo config; else derive it.
    let projectId = computeProjectId(abs);
    try {
      const repoCfg = JSON.parse(
        fs.readFileSync(path.join(abs, ".test-mcp", "config.json"), "utf8"),
      ) as { projectId?: string };
      if (repoCfg.projectId) projectId = repoCfg.projectId;
    } catch {
      // no repo config — derived id is fine
    }

    const project: RegisteredProject = { projectId, path: abs, configPath, status: "idle" };
    this.projects.set(projectId, project);
    await this.save();
    return { projectId, path: abs, status: project.status };
  }

  async list(): Promise<RegistrySummary[]> {
    return [...this.projects.values()].map((p) => ({
      projectId: p.projectId,
      path: p.path,
      status: p.status,
    }));
  }

  async unregister(projectId: string, purge = false): Promise<{ projectId: string; removed: true }> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new RegistryError("UnknownProject", `Project not registered: ${projectId}`);
    }
    this.projects.delete(projectId);
    await this.save();
    if (purge) {
      fs.rmSync(path.join(project.path, ".test-mcp"), { recursive: true, force: true });
    }
    return { projectId, removed: true };
  }
}
```

### Task 2 — Wire the registry into the MCP tools (AC: 3,4,5)

Edit `src/mcp/server.ts`. Change the deps to carry a registry and implement the three registry tool handlers. Leave the HTTP listener/security code (everything from `// --- HTTP security helpers ---` onward) UNCHANGED except that it already spreads `deps` into `createMcpServer` — verify it still passes `deps` through.

- Update the imports and deps interface:
  ```ts
  import { ProjectRegistry, RegistryError } from "../registry/project-registry.js";

  export interface McpServerDeps {
    /** Shared project registry (owned by the daemon). Absent in bare unit tests. */
    registry?: ProjectRegistry;
  }
  ```
  (Remove the old `isProjectRegistered` field. `McpListenerDeps extends McpServerDeps` and keeps `token`.)
- In `createMcpServer`, derive registration from the registry:
  ```ts
  export function createMcpServer(deps: McpServerDeps = {}): McpServer {
    const registry = deps.registry;
    const isRegistered = (projectId: string) => registry?.has(projectId) ?? false;
    const server = new McpServer({ name: "test-mcp", version: "0.0.0" });

    const unknownProject = (projectId: string) =>
      errorResult(toAppError("UnknownProject", `Project not registered: ${projectId}`));

    const requireRegisteredProject = (projectId: string) => {
      if (!isRegistered(projectId)) return unknownProject(projectId);
      return errorResult(
        toAppError("NotImplemented", "Project-scoped tool execution arrives in later stories"),
      );
    };
    // ...tool registrations below...
  }
  ```
- `register_project` handler — replace the `NotImplemented` body with:
  ```ts
  async ({ path: projectPath }) => {
    if (!registry) return errorResult(toAppError("NotImplemented", "registry unavailable"));
    try {
      const project = await registry.register(projectPath);
      return { content: [{ type: "text" as const, text: JSON.stringify(project) }] };
    } catch (e) {
      if (e instanceof RegistryError) return errorResult(toAppError(e.code, e.message));
      throw e;
    }
  },
  ```
- `list_projects` handler — replace the `NotImplemented` body with:
  ```ts
  async () => {
    const projects = registry ? await registry.list() : [];
    return { content: [{ type: "text" as const, text: JSON.stringify({ projects }) }] };
  },
  ```
- `unregister_project` handler — replace `requireRegisteredProject(projectId)` with:
  ```ts
  async ({ projectId, purge }) => {
    if (!registry || !registry.has(projectId)) return unknownProject(projectId);
    try {
      const result = await registry.unregister(projectId, purge ?? false);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (e) {
      if (e instanceof RegistryError) return errorResult(toAppError(e.code, e.message));
      throw e;
    }
  },
  ```
- Leave `run_tests`, `get_test_status`, `get_failure_details` calling `requireRegisteredProject(projectId)` unchanged.

### Task 3 — Instantiate the registry in the daemon (AC: 3,6)

Edit `src/daemon/index.ts`.

1. Add the import next to the existing imports:
   ```ts
   import { ProjectRegistry } from "../registry/project-registry.js";
   ```
2. Add a helper next to `configPath()`/`lockfilePath()`:
   ```ts
   export function registryPath(): string {
     return path.join(centralDir(), "registry.json");
   }
   ```
3. In `startDaemon()`, immediately after `const token = crypto.randomBytes(32).toString("hex");`, create the registry and pass it to the listener:
   ```ts
   const registry = new ProjectRegistry(registryPath());
   const server = http.createServer(createMcpRequestListener({ token, registry }));
   ```
   (Do NOT call `registry.load()` here — daemon-start rehydration is Story 1.4.)
4. In `getDaemonStatus()`, replace the hard-coded `registeredProjects: []` in the RUNNING branch (the final `return { running: true, pid: lock.pid, port: lock.port, registeredProjects: [] };`) with a count read from disk:
   ```ts
   let registeredProjects: string[] = [];
   try {
     const reg = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as {
       projects?: Record<string, unknown>;
     };
     registeredProjects = Object.keys(reg.projects ?? {});
   } catch {
     // no registry file yet
   }
   return { running: true, pid: lock.pid, port: lock.port, registeredProjects };
   ```
   Leave the two `running: false` branches returning `registeredProjects: []`.

### Task 4 — Implement CLI `init` and `register` (AC: 1,2)

Edit `src/cli/main.ts`. Replace ONLY the `init` and `register` command `.action(...)` bodies. Leave `start`/`stop`/`status` and the default-help block unchanged. Add these imports at the top (alongside the existing ones):

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readLockfile, isPidAlive } from "../daemon/index.js";
import { computeProjectId } from "../registry/project-registry.js";
import { SCHEMA_VERSION } from "../index.js";
```

Add these module-level helper functions (below the imports, above `const program = ...`):

```ts
/** Resolve the git root for a directory, or throw a clear error if not a git repo. */
function resolveGitRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(`not a git repository (or git not installed): ${cwd}`);
  }
}

/** Create <gitRoot>/.test-mcp/config.json if absent (idempotent). Returns the projectId. */
function ensureProjectConfig(gitRoot: string): string {
  const stateDir = path.join(gitRoot, ".test-mcp");
  const cfgPath = path.join(stateDir, "config.json");
  fs.mkdirSync(stateDir, { recursive: true });
  if (fs.existsSync(cfgPath)) {
    const existing = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { projectId?: string };
    if (existing.projectId) return existing.projectId;
  }
  const projectId = computeProjectId(gitRoot);
  const cfg = { schemaVersion: SCHEMA_VERSION, projectId, stateDir: ".test-mcp" };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return projectId;
}

/** Ensure ".test-mcp/" is present in <gitRoot>/.gitignore (idempotent). */
function ensureGitignore(gitRoot: string): void {
  const gitignorePath = path.join(gitRoot, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    // no .gitignore yet
  }
  const hasEntry = content
    .split(/\r?\n/)
    .some((line) => line.trim() === ".test-mcp/" || line.trim() === ".test-mcp");
  if (hasEntry) return;
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignorePath, `${prefix}.test-mcp/\n`);
}

/** Absolute path to this package's bin, resolved from the compiled module location. */
function binPath(): string {
  // dist/cli/main.js -> ../../bin/test-mcp.mjs
  return fileURLToPath(new URL("../../bin/test-mcp.mjs", import.meta.url));
}

/** Ensure the singleton daemon is running; auto-boot it detached unless noSpawn. Returns the lockfile. */
async function ensureDaemon(noSpawn: boolean): Promise<{ port: number; token: string }> {
  const existing = readLockfile();
  if (existing && isPidAlive(existing.pid)) return { port: existing.port, token: existing.token };
  if (noSpawn) {
    throw new Error("daemon not running and --no-spawn set; start it with `test-mcp start`");
  }
  const child = spawn(process.execPath, [binPath(), "start"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  // Poll up to ~5s for the daemon to write a live lockfile.
  for (let i = 0; i < 50; i++) {
    const lock = readLockfile();
    if (lock && isPidAlive(lock.pid)) return { port: lock.port, token: lock.token };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("daemon did not become ready within 5s");
}
```

Now the command bodies:

- `init` action (make it `async` is not required; keep sync):
  ```ts
  .action(() => {
    try {
      const gitRoot = resolveGitRoot(process.cwd());
      const projectId = ensureProjectConfig(gitRoot);
      ensureGitignore(gitRoot);
      console.log(`test-mcp init: project ${projectId} ready at ${gitRoot}`);
    } catch (err) {
      console.error(`test-mcp init: ${(err as Error).message}`);
      process.exit(1);
    }
  });
  ```
- `register` action — add the `--no-spawn` option and implement:
  ```ts
  program
    .command("register")
    .description("Register the current project with the daemon (Story 1.3)")
    .option("--no-spawn", "do not auto-boot the daemon; fail if it is not running")
    .action(async (opts: { spawn: boolean }) => {
      try {
        const gitRoot = resolveGitRoot(process.cwd());
        ensureProjectConfig(gitRoot);
        ensureGitignore(gitRoot);
        // commander sets opts.spawn = false when --no-spawn is passed.
        const { port, token } = await ensureDaemon(opts.spawn === false);
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
          { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
        );
        const client = new Client({ name: "test-mcp-cli", version: "0.0.0" });
        await client.connect(transport);
        const res = (await client.callTool({
          name: "register_project",
          arguments: { path: gitRoot },
        })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
        await client.close();
        const payload = JSON.parse(res.content[0].text) as {
          code?: string;
          message?: string;
          projectId?: string;
          path?: string;
        };
        if (res.isError) {
          console.error(`test-mcp register: ${payload.code}: ${payload.message}`);
          process.exit(1);
        }
        console.log(`test-mcp register: registered ${payload.projectId} (${payload.path})`);
        process.exit(0);
      } catch (err) {
        console.error(`test-mcp register: ${(err as Error).message}`);
        process.exit(1);
      }
    });
  ```
  (Replace the whole existing `program.command("register")...` block with this one. `--no-spawn` in commander produces `opts.spawn === false`.)

### Task 5 — Unit test the registry (AC: 3,4,5)

Create `test/project-registry.test.ts`:

```ts
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ProjectRegistry,
  RegistryError,
  computeProjectId,
} from "../src/registry/project-registry.ts";

let tmp: string;
let projectDir: string;
let registryFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-reg-"));
  projectDir = path.join(tmp, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "vitest.config.ts"), "export default {};\n");
  registryFile = path.join(tmp, "central", "registry.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ProjectRegistry", () => {
  it("registers a project with a valid config and persists registry.json", async () => {
    const reg = new ProjectRegistry(registryFile);
    const summary = await reg.register(projectDir);
    expect(summary.projectId).toBe(computeProjectId(projectDir));
    expect(summary.path).toBe(fs.realpathSync(projectDir));
    expect(summary.status).toBe("idle");
    expect(reg.has(summary.projectId)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    expect(onDisk.schemaVersion).toBe(1);
    expect(Object.keys(onDisk.projects)).toContain(summary.projectId);
  });

  it("rejects a directory with no vitest/vite config (InvalidConfig)", async () => {
    const reg = new ProjectRegistry(registryFile);
    const noConfig = path.join(tmp, "empty");
    fs.mkdirSync(noConfig);
    await expect(reg.register(noConfig)).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  it("lists and unregisters projects; unknown id throws UnknownProject", async () => {
    const reg = new ProjectRegistry(registryFile);
    const { projectId } = await reg.register(projectDir);
    expect(await reg.list()).toHaveLength(1);
    const removed = await reg.unregister(projectId);
    expect(removed).toEqual({ projectId, removed: true });
    expect(await reg.list()).toHaveLength(0);
    await expect(reg.unregister("nope")).rejects.toBeInstanceOf(RegistryError);
  });

  it("load() rehydrates from an existing registry.json", async () => {
    const first = new ProjectRegistry(registryFile);
    const { projectId } = await first.register(projectDir);
    const second = new ProjectRegistry(registryFile);
    expect(second.has(projectId)).toBe(false); // not loaded yet
    await second.load();
    expect(second.has(projectId)).toBe(true);
  });
});
```

> Note: `path` values are compared with `fs.realpathSync` because macOS `os.tmpdir()` is a symlink (`/var` → `/private/var`); `path.resolve` does not resolve symlinks, so assert against `fs.realpathSync(projectDir)` only if a mismatch appears. If `summary.path` equals `path.resolve(projectDir)` on your machine, use that instead — the implementation uses `path.resolve`, so prefer `expect(summary.path).toBe(path.resolve(projectDir))` and drop the realpath call.

### Task 6 — MCP registry tools over in-memory transport (AC: 3,4,5)

Create `test/mcp-registry.test.ts`:

```ts
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { ProjectRegistry } from "../src/registry/project-registry.ts";

let tmp: string;
let projectDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-mcpreg-"));
  projectDir = path.join(tmp, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "vitest.config.ts"), "export default {};\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connect(registry: ProjectRegistry) {
  const server = createMcpServer({ registry });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, server };
}

function textOf(res: unknown): { isError?: boolean; text: string } {
  const r = res as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: r.isError, text: r.content[0].text };
}

describe("MCP registry tools", () => {
  it("register_project → list_projects → unregister_project round-trip", async () => {
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { client, server } = await connect(registry);

    const reg = textOf(await client.callTool({ name: "register_project", arguments: { path: projectDir } }));
    expect(reg.isError).toBeFalsy();
    const { projectId } = JSON.parse(reg.text) as { projectId: string };

    const list = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
    const { projects } = JSON.parse(list.text) as { projects: Array<{ projectId: string }> };
    expect(projects.map((p) => p.projectId)).toContain(projectId);

    // A registered project now takes the NotImplemented path (execution is a later epic).
    const run = textOf(await client.callTool({ name: "run_tests", arguments: { projectId } }));
    expect(run.isError).toBe(true);
    expect(JSON.parse(run.text).code).toBe("NotImplemented");

    const unreg = textOf(await client.callTool({ name: "unregister_project", arguments: { projectId } }));
    expect(JSON.parse(unreg.text)).toEqual({ projectId, removed: true });

    await client.close();
    await server.close();
  });

  it("register_project on a config-less path returns InvalidConfig", async () => {
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { client, server } = await connect(registry);
    const noConfig = path.join(tmp, "empty");
    fs.mkdirSync(noConfig);
    const res = textOf(await client.callTool({ name: "register_project", arguments: { path: noConfig } }));
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text).code).toBe("InvalidConfig");
    await client.close();
    await server.close();
  });

  it("unregister of an unknown projectId returns UnknownProject", async () => {
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { client, server } = await connect(registry);
    const res = textOf(await client.callTool({ name: "unregister_project", arguments: { projectId: "nope" } }));
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text).code).toBe("UnknownProject");
    await client.close();
    await server.close();
  });
});
```

### Task 7 — CLI register integration test (AC: 1,2)

Create `test/cli-register.test.ts`. This spawns the built CLI as a child process. **Reuse the proven pattern from `test/cli-daemon.test.ts`**: resolve the repo root and bin path from `import.meta.url`, pass `cwd` + an absolute bin path, capture child stderr, `unref()` detached children, and poll instead of fixed sleeps. Do NOT use a relative bin path with no `cwd` (that was the Story 1.1 looping trap).

```ts
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = path.join(repoRoot, "bin", "test-mcp.mjs");

let home: string; // central daemon dir (TEST_MCP_HOME)
let project: string; // a temp git repo with a vitest config
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cli-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cli-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: project });
  fs.writeFileSync(path.join(project, "vitest.config.ts"), "export default {};\n");
  // port 0 => OS picks a free port for the auto-booted daemon.
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ schemaVersion: 1, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }),
  );
  env = { ...process.env, TEST_MCP_HOME: home };
});

afterEach(async () => {
  // Best-effort daemon stop so no server leaks.
  try {
    await execFileAsync(process.execPath, [bin, "stop"], { cwd: project, env });
  } catch {
    // ignore
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe("test-mcp register (CLI)", () => {
  it("init creates repo config + gitignore entry (idempotent)", async () => {
    await execFileAsync(process.execPath, [bin, "init"], { cwd: project, env });
    const cfg = JSON.parse(fs.readFileSync(path.join(project, ".test-mcp", "config.json"), "utf8"));
    expect(cfg.projectId).toBeTruthy();
    expect(cfg.stateDir).toBe(".test-mcp");
    expect(fs.readFileSync(path.join(project, ".gitignore"), "utf8")).toContain(".test-mcp/");
    // idempotent: second run keeps the same projectId and doesn't duplicate the ignore line.
    await execFileAsync(process.execPath, [bin, "init"], { cwd: project, env });
    const cfg2 = JSON.parse(fs.readFileSync(path.join(project, ".test-mcp", "config.json"), "utf8"));
    expect(cfg2.projectId).toBe(cfg.projectId);
    const ignoreLines = fs
      .readFileSync(path.join(project, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() === ".test-mcp/");
    expect(ignoreLines).toHaveLength(1);
  });

  it("register --no-spawn fails when the daemon is not running", async () => {
    await expect(
      execFileAsync(process.execPath, [bin, "register", "--no-spawn"], { cwd: project, env }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("register auto-boots the daemon and registers the project", async () => {
    const { stdout } = await execFileAsync(process.execPath, [bin, "register"], {
      cwd: project,
      env,
    });
    expect(stdout).toContain("registered");
    // The central registry.json now contains this project's id.
    const reg = JSON.parse(fs.readFileSync(path.join(home, "registry.json"), "utf8"));
    const cfg = JSON.parse(fs.readFileSync(path.join(project, ".test-mcp", "config.json"), "utf8"));
    expect(Object.keys(reg.projects)).toContain(cfg.projectId);
    // status reflects the registration.
    const status = await execFileAsync(process.execPath, [bin, "status"], { cwd: project, env });
    expect(status.stdout).toContain("registered projects: 1");
  });
});
```

### Task 8 — Verify (AC: all)

- [ ] `pnpm run typecheck` → exit 0
- [ ] `pnpm run build` → exit 0
- [ ] `pnpm test` → all tests pass (existing + `project-registry` + `mcp-registry` + `cli-register`)
- [ ] `node bin/test-mcp.mjs --help` → still lists `init register start stop status`
- [ ] Manual (optional): in this repo, `TEST_MCP_HOME=$(mktemp -d) node bin/test-mcp.mjs register` → prints `registered <id>`; then `... status` shows `registered projects: 1`; then `... stop`.

## Dev Notes

### Architecture invariants that constrain this story
- **Per-project state is repo-local + git-ignored** in `<git-root>/.test-mcp/`; the daemon-global registry lives centrally in `~/.test-mcp/registry.json`. Never write project state centrally or vice versa. [Source: docs/architecture.md#Invariants (3), #Data Model]
- **Every project-scoped tool call carries a `projectId`; unknown → error.** [Source: docs/architecture.md#Invariants (4), #Error Taxonomy]
- **Schemas are versioned** — `registry.json` and the repo `config.json` both carry `schemaVersion` (= `SCHEMA_VERSION`). [Source: docs/architecture.md#Invariants (6)]
- **Auto-boot is the singleton path** — local `register` boots the daemon; CI uses `--no-spawn`. The daemon binds loopback only (unchanged from 1.1). [Source: docs/architecture.md#Process & Deployment Topology, #Execution Flows]
- **Error taxonomy:** `InvalidConfig` (no resolvable config), `UnknownProject` (id not registered), `DaemonUnavailable` (CLI cannot reach/boot the daemon). [Source: docs/architecture.md#Error Taxonomy]

### Registration flow (what calls what) [Source: docs/architecture.md#Execution Flows]
`test-mcp register` → resolve git-root → ensure `.test-mcp/config.json` (+ `projectId`, `stateDir`) → ensure `.test-mcp/` in `.gitignore` → ensure daemon up (auto-boot unless `--no-spawn`) → connect as an MCP client with the lockfile's bearer token → `register_project({ path: gitRoot })` → daemon validates the vitest/vite config, records in `registry.json`, returns the registration.

### Previous story intelligence
- **Child-process trap (Story 1.1):** spawning the CLI with a relative bin path and no `cwd` fails silently under the vitest worker (cwd ≠ repo root) → the daemon never boots → the model loops. ALWAYS resolve `repoRoot`/`bin` from `import.meta.url` and pass `cwd` + an absolute bin path. The CLI's own `binPath()` uses `import.meta.url` for the same reason. [Story 1.1 Debug Log]
- **Dependency trap (Story 1.2):** a build/typecheck error that smells like deps (`ERR_PACKAGE_PATH_NOT_EXPORTED`, `TS2589`, missing `dist`) is NOT yours to fix by editing `package.json`/lockfile/`.npmrc`. This story adds no deps; if such an error appears, STOP and report. [Story 1.2 Debug Log; CLAUDE.md]
- **Hermetic tests:** set `TEST_MCP_HOME` to a temp dir, use `port: 0`, and always stop/close daemons and clients in teardown (a live server or open client leaks and hangs the run). [Story 1.1/1.2]
- **`registerTool` gotchas (SDK 1.12.1):** config key is `description` not `title`; `inputSchema` is a raw Zod shape; never return `structuredContent` without an `outputSchema` (error/success results carry JSON in a `text` content block). [Story 1.2]

### Scope reminders
- `run_tests`/`get_test_status`/`get_failure_details` for a *registered* project still return `NotImplemented` — execution is Epic 2. Do not implement it.
- Do NOT wire `registry.load()` into daemon start, and do NOT add schemaVersion migration — that is Story 1.4. `registry.load()` exists and is unit-tested, but is not called on boot yet.
- If a task genuinely blocks (e.g. the auto-boot path won't stabilise), set the story Status to `review` with a truthful Dev Agent Record of what passes and what is blocked, and hand back. Do NOT thrash on install/dependency/`.npmrc` changes.

### Project Structure Notes
- `src/registry/project-registry.ts`, `src/mcp/server.ts`, `src/daemon/index.ts`, `src/cli/main.ts` already exist; replace/extend them in place. New tests go in `test/` (matches `vitest.config.ts` `include: ["test/**/*.test.ts"]`). No path changes, no new source files beyond the three tests.

### Testing standards
- Vitest, `environment: node`. Registry unit tests use an injected temp `registry.json` path + a fixture project dir with a `vitest.config.ts`. MCP tool tests use the in-memory transport with a real `ProjectRegistry`. The CLI test spawns the built bin (absolute path + `cwd`), `git init`s a temp project, and stops the daemon in teardown.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.3: Project Registration via `test-mcp register`]
- [Source: docs/architecture.md#Invariants]
- [Source: docs/architecture.md#Data Model]
- [Source: docs/architecture.md#Execution Flows]
- [Source: docs/architecture.md#Error Taxonomy]
- [Source: docs/patterns.md#Project Registration & State Layout Pattern]
- [Source: docs/patterns.md#CLI Bootstrap Pattern]
- [Source: docs/project-context.md]
- [Source: story-1-2-mcp-server-over-streamable-http-secured.md (MCP deps injection; hermetic HTTP/client test patterns)]
- [Source: story-1-1-singleton-daemon-lifecycle-cli.md (lockfile shape; child-process spawn pattern)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
