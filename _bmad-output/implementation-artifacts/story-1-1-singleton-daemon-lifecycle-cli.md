# Story 1.1: Singleton Daemon Lifecycle & CLI

Status: ready-for-dev

**Prerequisite:** Story 1.0 complete (scaffold verified, `done`). Do not restructure the repo.

<!-- This story is implemented by a local model (qwen3-coder-next). Instructions are literal and
     copy-paste ready ON PURPOSE. Follow them exactly. Do not infer, improvise, or add scope. -->

## Story

As an AI agent (via the developer's toolchain),
I want a single always-on daemon I can start, stop, and inspect,
so that exactly one instance manages all projects and I never race competing servers.

## Acceptance Criteria

1. **Start binds loopback + writes lockfile.** `test-mcp start` loads/creates the central daemon config, starts an HTTP server bound to `127.0.0.1` on the configured port, and writes `~/.test-mcp/daemon.lock` containing `{ pid, port, token, startedAt }` with file mode `0600`. (Invariant 1; architecture §Transport & Security, §Data Model)
2. **Singleton enforced.** If a daemon is already running (lockfile exists and its `pid` is alive), `test-mcp start` does NOT start a second server; it reports the running instance's `pid` and `port` and exits `0`.
3. **Status reports state.** `test-mcp status` prints `running` with `pid`/`port`/registered-project count when a live daemon exists, or `stopped` otherwise; exits `0` in both cases. (Registry is Story 1.3 — registered-project count is always `0` in this story.)
4. **Stop is clean + idempotent.** `test-mcp stop` on a running daemon shuts it down cleanly (closes the server) and removes the lockfile; on no/dead daemon it reports "not running" and exits `0`.
5. **Stale lockfile reclaimed.** If a lockfile exists but its `pid` is dead, `test-mcp start` detects the dead pid, discards the stale lockfile, and starts normally (new lockfile has the new pid).
6. **Config persisted with schemaVersion.** The central config `~/.test-mcp/config.json` is created on first `start` if absent, carries `schemaVersion` equal to `SCHEMA_VERSION` (from `src/index.ts`), and loading a file whose `schemaVersion` differs is rejected with a clear error (no crash of the CLI process). (Invariant 6)
7. **Scope isolation.** No MCP server, no auth enforcement (Host/Origin/bearer checking), no project registry, and no worker/Vitest logic are implemented here — those remain stubs for Stories 1.2–2.1. The generated bearer `token` is only written to the lockfile; it is NOT yet enforced on requests.

## Tasks / Subtasks

### Task 1 — Implement daemon lifecycle module (AC: 1,2,3,4,5,6,7)

Replace the stub body of `src/daemon/index.ts` (only this file for the daemon logic — do NOT add new files under `src/daemon/`). Use **Node built-ins only** (`node:fs`, `node:path`, `node:os`, `node:http`, `node:crypto`). Do NOT add any dependency.

- [ ] Export these exact types and functions (names and signatures are fixed):
  ```ts
  export interface DaemonConfig { schemaVersion: number; port: number; maxConcurrentWorkers: number; workerIdleTtlMs: number; }
  export interface Lockfile { pid: number; port: number; token: string; startedAt: string; }
  export interface DaemonHandle { pid: number; port: number; token: string; alreadyRunning: boolean; close(): Promise<void>; }
  export interface DaemonStatus { running: boolean; pid?: number; port?: number; registeredProjects: string[]; }

  export function centralDir(): string;
  export function configPath(): string;
  export function lockfilePath(): string;
  export function isPidAlive(pid: number): boolean;
  export function readLockfile(): Lockfile | null;
  export function loadOrCreateConfig(): DaemonConfig;
  export function startDaemon(): Promise<DaemonHandle>;
  export function stopDaemon(): Promise<{ stopped: boolean; pid?: number; reason?: string }>;
  export function getDaemonStatus(): Promise<DaemonStatus>;
  ```
- [ ] `centralDir()`: return `process.env.TEST_MCP_HOME` when it is a non-empty string, else `path.join(os.homedir(), ".test-mcp")`. (The env override exists so tests are hermetic — always resolve the dir through this function, never hard-code it.)
- [ ] `configPath()` = `path.join(centralDir(), "config.json")`. `lockfilePath()` = `path.join(centralDir(), "daemon.lock")`.
- [ ] `isPidAlive(pid)`: `try { process.kill(pid, 0); return true; } catch (e: any) { return e && e.code === "EPERM"; }` (EPERM ⇒ process exists but not signalable ⇒ alive; ESRCH ⇒ dead).
- [ ] `readLockfile()`: read+`JSON.parse` `lockfilePath()`; return `null` if the file does not exist or cannot be parsed (do not throw).
- [ ] `loadOrCreateConfig()`:
  - `fs.mkdirSync(centralDir(), { recursive: true, mode: 0o700 })`.
  - If `configPath()` exists: parse it; if `parsed.schemaVersion !== SCHEMA_VERSION` throw `new Error("Unsupported config schemaVersion " + parsed.schemaVersion + " (expected " + SCHEMA_VERSION + ")")`; else return it.
  - Else build `const cfg = { schemaVersion: SCHEMA_VERSION, port: 7420, maxConcurrentWorkers: Math.max(1, os.cpus().length), workerIdleTtlMs: 300000 }`, write it with `JSON.stringify(cfg, null, 2)`, return `cfg`.
  - Import `SCHEMA_VERSION` from `../index.js` (NodeNext requires the `.js` extension on the import specifier).
- [ ] `startDaemon()`:
  1. `fs.mkdirSync(centralDir(), { recursive: true, mode: 0o700 })`.
  2. `const existing = readLockfile();` if `existing && isPidAlive(existing.pid)` → return `{ pid: existing.pid, port: existing.port, token: existing.token, alreadyRunning: true, close: async () => {} }` (do NOT bind a server).
  3. If `existing` (stale) → `fs.rmSync(lockfilePath(), { force: true })`.
  4. `const cfg = loadOrCreateConfig();`
  5. `const token = crypto.randomBytes(32).toString("hex");`
  6. Create `const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "ok", daemon: "test-mcp" })); });`
  7. `await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(cfg.port, "127.0.0.1", () => resolve()); });`
  8. `const addr = server.address(); const port = addr && typeof addr === "object" ? addr.port : cfg.port;`
  9. `const lock: Lockfile = { pid: process.pid, port, token, startedAt: new Date().toISOString() };`
  10. `fs.writeFileSync(lockfilePath(), JSON.stringify(lock, null, 2), { mode: 0o600 }); fs.chmodSync(lockfilePath(), 0o600);`
  11. `const close = async () => { await new Promise<void>((r) => server.close(() => r())); const cur = readLockfile(); if (cur && cur.pid === process.pid) fs.rmSync(lockfilePath(), { force: true }); };`
  12. return `{ pid: process.pid, port, token, alreadyRunning: false, close };`
- [ ] `stopDaemon()`:
  1. `const lock = readLockfile();` if `!lock` → return `{ stopped: false, reason: "not running" }`.
  2. if `!isPidAlive(lock.pid)` → `fs.rmSync(lockfilePath(), { force: true }); return { stopped: false, reason: "stale" };`
  3. `process.kill(lock.pid, "SIGTERM");`
  4. Poll for lockfile removal: up to 50 iterations of 100ms; each iteration `if (!fs.existsSync(lockfilePath())) return { stopped: true, pid: lock.pid };`
  5. After the loop, `fs.rmSync(lockfilePath(), { force: true }); return { stopped: true, pid: lock.pid };`
- [ ] `getDaemonStatus()`:
  1. `const lock = readLockfile();` if `!lock` → `return { running: false, registeredProjects: [] };`
  2. if `!isPidAlive(lock.pid)` → `fs.rmSync(lockfilePath(), { force: true }); return { running: false, registeredProjects: [] };`
  3. `return { running: true, pid: lock.pid, port: lock.port, registeredProjects: [] };`

### Task 2 — Wire CLI start/stop/status (AC: 1,2,3,4)

Edit `src/cli/main.ts`. Replace ONLY the `start`, `stop`, and `status` command `.action(...)` bodies (currently print "not implemented (Story 1.1)" and `process.exit(1)`). Leave `init` (exit 0) and `register` (still "not implemented (Story 1.3)", exit 1) exactly as they are. Import `{ startDaemon, stopDaemon, getDaemonStatus }` from `../daemon/index.js`.

- [ ] `start` action (async):
  ```ts
  const h = await startDaemon();
  if (h.alreadyRunning) { console.log(`test-mcp daemon already running (pid ${h.pid}, port ${h.port})`); process.exit(0); }
  console.log(`test-mcp daemon started (pid ${h.pid}, port ${h.port})`);
  const shutdown = async () => { await h.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  ```
  (Do not call `process.exit` in the non-already-running branch — the HTTP server keeps the process alive until a signal arrives. This is the foreground daemon for this story; detached auto-boot is Story 1.3.)
- [ ] `stop` action (async):
  ```ts
  const r = await stopDaemon();
  console.log(r.stopped ? `test-mcp daemon stopped (pid ${r.pid})` : `test-mcp daemon not running`);
  process.exit(0);
  ```
- [ ] `status` action (async):
  ```ts
  const s = await getDaemonStatus();
  console.log(s.running
    ? `test-mcp daemon: running (pid ${s.pid}, port ${s.port}, registered projects: ${s.registeredProjects.length})`
    : `test-mcp daemon: stopped`);
  process.exit(0);
  ```

### Task 3 — Unit tests for the daemon module (AC: 1,2,3,5,6)

Create `test/daemon.test.ts` (Vitest). Make it hermetic: in `beforeEach` set `process.env.TEST_MCP_HOME` to a fresh temp dir (`fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-"))`); in `afterEach` close any open handle, delete the env var, and `fs.rmSync(dir, { recursive: true, force: true })`. Import from `../src/daemon/index.ts`.

- [ ] `startDaemon` writes a lockfile with `pid === process.pid`, `port > 0`, a non-empty `token`, and a parseable `startedAt`; and the config file is created with `schemaVersion === SCHEMA_VERSION`. Close the handle at the end.
- [ ] The server actually listens on loopback: `const res = await fetch("http://127.0.0.1:" + h.port + "/"); expect(res.status).toBe(200);` (Node 20+ global `fetch`). Then close the handle.
- [ ] Calling `startDaemon()` a second time (while the first handle is open) returns `alreadyRunning === true` with the same `port`.
- [ ] Stale reclaim: write a lockfile manually with a dead sentinel pid `{ pid: 2147483647, port: 1, token: "x", startedAt: new Date().toISOString() }`, then `startDaemon()` succeeds and the new lockfile has `pid === process.pid`. Close the handle.
- [ ] `getDaemonStatus()` returns `running: true` with matching pid/port while a handle is open, and `running: false` after `await handle.close()`.
- [ ] `stopDaemon()` returns `{ stopped: false, reason: "not running" }` when no lockfile exists, and `{ stopped: false, reason: "stale" }` (and deletes the lockfile) when the lockfile pid is the dead sentinel.
- [ ] `loadOrCreateConfig()` throws when the on-disk config has a mismatched `schemaVersion` (write `{ schemaVersion: 999, ... }` first).

> Do NOT call `stopDaemon()` against a live lockfile whose pid is `process.pid` in a unit test — it sends `SIGTERM` to the test runner. The live-kill path is covered by the integration test in Task 4.

### Task 4 — CLI integration test for the real stop path (AC: 1,2,3,4)

Create `test/cli-daemon.test.ts` (Vitest). Spawns the built CLI as a child process so the SIGTERM stop path is exercised end-to-end.

- [ ] Setup: `const home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cli-"));` and write `path.join(home, "config.json")` = `{ schemaVersion: <SCHEMA_VERSION>, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }` (port `0` ⇒ OS picks a free port ⇒ no clash with a real daemon on 7420). Pass `env: { ...process.env, TEST_MCP_HOME: home }` to every child.
- [ ] Spawn `node bin/test-mcp.mjs start` (detached child, capture nothing critical). Poll up to ~5s for `fs.existsSync(path.join(home, "daemon.lock"))`. Read+parse it: assert `pid > 0`, `port > 0`, `token` non-empty.
- [ ] Run `execFile("node", ["bin/test-mcp.mjs", "status"], { env })` → assert stdout contains `running` and the pid.
- [ ] Run `execFile("node", ["bin/test-mcp.mjs", "stop"], { env })` → assert exit 0 and stdout contains `stopped`; then poll up to ~5s that `daemon.lock` no longer exists.
- [ ] Teardown: if the start child is still alive, `child.kill("SIGKILL")`; `fs.rmSync(home, { recursive: true, force: true })`.

### Task 5 — Verify (AC: all)

- [ ] `pnpm run typecheck` → exit 0
- [ ] `pnpm run build` → exit 0
- [ ] `pnpm test` → all tests pass (smoke + cli-main + daemon + cli-daemon)
- [ ] `node bin/test-mcp.mjs --help` → still lists `init register start stop status`
- [ ] Manual (optional): `TEST_MCP_HOME=$(mktemp -d) node bin/test-mcp.mjs start &` then `TEST_MCP_HOME=<same> node bin/test-mcp.mjs status` (running) then `... stop` (stopped)

## Dev Notes

### Scope boundaries (do NOT overstep)
- **Only touch:** `src/daemon/index.ts`, `src/cli/main.ts`, and the two new test files. Do not modify other `src/` modules, `package.json`, `tsconfig.json`, or the scaffold layout.
- **Not in this story:** MCP server (`src/mcp/server.ts` stays a Story 1.2 stub), auth enforcement (Host/Origin/bearer validation on requests — the token is generated and stored only), project registry (`src/registry/*` stays a Story 1.3 stub), worker/Vitest execution. The HTTP server here is a minimal placeholder that returns `200 {status:"ok"}` for any request; the MCP layer replaces its request handling in Story 1.2.

### Architecture invariants that constrain this story
- **One daemon per system**, enforced by lockfile + known port in the central dir. [Source: docs/architecture.md#Invariants (1)]
- **Bind loopback only** (`127.0.0.1`), never `0.0.0.0`. [Source: docs/architecture.md#Transport & Security]
- **Per-daemon bearer token** generated on start, written `0600` to `~/.test-mcp/daemon.lock` alongside pid/port. [Source: docs/architecture.md#Transport & Security]
- **Every persisted JSON carries `schemaVersion`.** Use `SCHEMA_VERSION` from `src/index.ts`. On load, mismatched version → clear error (migrations are a later concern). [Source: docs/architecture.md#Invariants (6), #Cross-Cutting]

### Canonical data shapes [Source: docs/architecture.md#Data Model]
- Daemon config (`~/.test-mcp/config.json`): `{ schemaVersion, port: 7420, maxConcurrentWorkers, workerIdleTtlMs }`.
- Lockfile (`~/.test-mcp/daemon.lock`): `{ pid, port, token, startedAt }`.
- `~/.test-mcp/` is the **central** (daemon-global) dir — distinct from a project's `<git-root>/.test-mcp/` (Story 1.3). This story only ever touches the central dir.

### Toolchain (from docs/project-context.md — MUST follow)
- **pnpm only.** Commands: `pnpm install`, `pnpm run typecheck`, `pnpm run build`, `pnpm test`. Never `npm`/`yarn`.
- ESM + NodeNext: all relative imports use the `.js` extension in the specifier (e.g. `import { SCHEMA_VERSION } from "../index.js";`), even though the source file is `.ts`.
- Node 20+, `strict` TypeScript. No new dependencies — Node built-ins only.
- `pretest` runs `pnpm build` automatically, so `pnpm test` works on a clean checkout.

### Previous story intelligence (Story 1.0)
- The scaffold paths are fixed — add behaviour to existing files, never relocate. [Story 1.0 learning]
- Zod schemas in `src/types/contracts.ts` are intentionally placeholder `z.object({})` stubs until Story 1.2 — do not "fix" them here.
- `src/index.ts` exports `SCHEMA_VERSION = 1` — reuse it for `schemaVersion`.
- Tests are excluded from `tsconfig.json` (`typecheck` covers `src/**` only); Vitest type-checks nothing, so keep test imports runtime-correct. Existing tests import source with a `.ts` extension (e.g. `../src/index.ts`) — follow that exact convention in the new test files.

### Project Structure Notes
- `src/daemon/index.ts` and `src/cli/main.ts` already exist as stubs (created in Story 1.0). This story replaces stub bodies in place. No new source files, no path changes. New test files live in `test/` (matches `vitest.config.ts` `include: ["test/**/*.test.ts"]`).

### Testing standards
- Vitest, `environment: node`. Hermetic via `TEST_MCP_HOME` pointing at a temp dir per test — never write to the real `~/.test-mcp/`. Always close daemon handles / kill child processes in teardown to avoid leaked ports and a hanging test run.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.1: Singleton Daemon Lifecycle & CLI]
- [Source: docs/architecture.md#Invariants]
- [Source: docs/architecture.md#Transport & Security]
- [Source: docs/architecture.md#Data Model]
- [Source: docs/architecture.md#Concurrency & Lifecycle]
- [Source: docs/architecture.md#Error Taxonomy] (`DaemonUnavailable` is CLI-side; full error envelope enforcement is Story 1.2)
- [Source: docs/project-context.md]

## Dev Agent Record

### Agent Model Used

(to be filled by the implementing model, e.g. qwen3-coder-next)

### Debug Log References

### Completion Notes List

### File List

## Status
ready-for-dev
