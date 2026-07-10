# Architecture

Lean architectural spine for the MCP Test Runner. This is the source of truth for
component boundaries, contracts, and the invariants everything else is built from.
Companion docs: `docs/prd.md` (what & why), `docs/patterns.md` (validated code patterns).

> APIs referenced here were validated July 2026: `@modelcontextprotocol/sdk` v1
> (`McpServer`, `StreamableHTTPServerTransport`), Vitest 3.2+/4.x `vitest/node`.

## Invariants

These must hold across every component and story:

1. **One daemon per system.** Enforced by a lockfile + known port in the central dir.
2. **Tests always run under the project's own Vitest.** The daemon process never imports
   a project's `vitest`; execution is delegated to a per-project worker subprocess with
   `cwd = projectRoot`.
3. **Per-project state is repo-local and git-ignored.** It lives in `<git-root>/.test-mcp/`;
   daemon-global state lives centrally and never inside a project.
4. **Every project-scoped tool call carries a `projectId`.** Unknown `projectId` → error.
5. **Correctness over cleverness.** When test selection is uncertain (unknown file, stale
   map), fall back to the full suite. Never silently skip.
6. **Schemas are versioned.** Every persisted JSON file carries `schemaVersion`.

## Component Overview

```
                         ┌─────────────────────────────────────────────┐
   AI agent / CI ──MCP──▶ │  Daemon (single process)                    │
                         │                                             │
   test-mcp CLI ────────▶ │  ┌───────────────┐   ┌────────────────────┐ │
   (start/register/…)    │  │ MCP Layer     │   │ Project Registry   │ │
                         │  │ (HTTP+stdio)  │   │ (central state)    │ │
                         │  └──────┬────────┘   └────────────────────┘ │
                         │         │                                    │
                         │  ┌──────▼────────┐   ┌────────────────────┐ │
                         │  │ Orchestrator  │──▶│ Selection Engine   │ │
                         │  │ (per-project  │   │ (git delta ∪ cov)  │ │
                         │  │  worker pool) │   └─────────┬──────────┘ │
                         │  └──────┬────────┘             │            │
                         └─────────┼───────────────────────┼──────────┘
                                   │ fork + IPC            │ reads/writes
                          ┌────────▼─────────┐    ┌─────────▼──────────┐
                          │ Worker (per proj)│    │ <git-root>/        │
                          │ cwd=projectRoot  │    │   .test-mcp/       │
                          │ project vitest   │    │  (coverage map,    │
                          │ createVitest()   │    │   history, config) │
                          └──────────────────┘    └────────────────────┘
```

**Components:**

- **CLI (`test-mcp`)** — thin launcher/client, no Vitest coupling; safe to install
  globally or run via `npx`. Commands: `init`, `register`, `start`, `stop`, `status`.
- **MCP Layer** — `McpServer` + tool registration; Streamable HTTP transport (primary)
  and optional stdio single-project mode. Handles auth, Host/Origin validation, sessions.
- **Project Registry** — central record of registered projects (`projectId` → path,
  configPath, status); persisted in the central dir; rehydrated on daemon start.
- **Orchestrator** — owns the per-project **worker pool**, run queue, cancellation,
  concurrency caps, and idle reaping.
- **Selection Engine** — decides which test files to run (git-delta ∪ coverage-map),
  builds dry-run plans.
- **Coverage Engine** — builds/updates the source→test reverse map from runtime V8
  coverage (runs inside the worker; persisted per project).
- **Worker** — per-project subprocess that resolves and drives the project's own Vitest.

## Process & Deployment Topology

- Single daemon process, plus **N worker subprocesses** (≤ one per active project,
  bounded by a global concurrency cap).
- Local dev: `test-mcp register` auto-boots the daemon (singleton). CI: run an explicit
  ephemeral daemon per job (`test-mcp start`) and `register --no-spawn`.
- Transport: Streamable HTTP bound to `127.0.0.1` only.

## Transport & Security

- **Bind loopback only** (`127.0.0.1`). Never `0.0.0.0`.
- **Host/Origin validation** is mandatory (required when using
  `StreamableHTTPServerTransport` directly rather than the express helper) — mitigates
  DNS-rebinding / malicious-webpage attacks against a localhost server.
- **Per-daemon bearer token**: generated on daemon start, written `0600` to
  `~/.test-mcp/daemon.lock` alongside pid/port. The CLI reads it and injects
  `Authorization: Bearer <token>`; MCP requests without it are rejected.
- Sessions: `StreamableHTTPServerTransport({ sessionIdGenerator })` with a
  session→transport map keyed by `Mcp-Session-Id`.

## Data Model

All files are JSON with a `schemaVersion`. Locations per invariant 3.

**Daemon config** (central, e.g. `~/.test-mcp/config.json`)
```jsonc
{
  "schemaVersion": 1,
  "port": 7420,
  "maxConcurrentWorkers": 4,      // default: derived from CPU count
  "workerIdleTtlMs": 300000
}
```

**Lockfile** (central, `~/.test-mcp/daemon.lock`) — `{ pid, port, token, startedAt }`.

**Project registry** (central, `~/.test-mcp/registry.json`)
```jsonc
{
  "schemaVersion": 1,
  "projects": {
    "<projectId>": { "path": "/abs/path", "configPath": "…/vitest.config.ts", "status": "idle" }
  }
}
```

**Project config** (repo, `<git-root>/.test-mcp/config.json`, git-ignored)
```jsonc
{
  "schemaVersion": 1,
  "projectId": "a1b2c3…",          // default: hash of absolute path; pinnable
  "stateDir": ".test-mcp"
}
```

**Coverage map** (repo, `<git-root>/.test-mcp/coverage-map.json`)
```jsonc
{
  "schemaVersion": 1,
  "builtAt": "2026-07-10T12:00:00Z",
  "entries": {
    "src/foo.ts": { "tests": ["test/foo.test.ts"], "measuredHash": "…" }
  }
}
```

**Run history** (repo, `<git-root>/.test-mcp/history/*.json`) — per-run records:
counts, duration, failures, selection reasoning, and (Phase 2) failure/flake stats.

**Plan cache** (in-memory, daemon) — `planId → { projectId, files, reasoning, createdAt }`
with short TTL; used by the dry-run → commit flow.

## MCP Tool Contracts

Input schemas are Zod; `outputSchema` gives structured results. Summary contracts
(authoritative shapes; refine field-by-field during Story implementation):

| Tool | Input | Output |
|------|-------|--------|
| `register_project` | `{ path }` | `{ projectId, path, status }` |
| `list_projects` | `{}` | `{ projects: [{ projectId, path, status }] }` |
| `unregister_project` | `{ projectId, purge? }` | `{ projectId, removed: true }` |
| `run_tests` | `{ projectId, mode?, files?, suite?, dryRun?, planId? }` | `TestResult` \| `TestPlan` |
| `get_test_status` | `{ projectId }` | `{ state: idle\|running\|complete\|error, latest?: TestResult }` |
| `get_failure_details` | `{ projectId, failureId }` | `{ name, file, message, stack, assertion? }` |

```typescript
interface TestResult {
  success: boolean; duration: number;
  total: number; passed: number; failed: number; skipped: number;
  failures: Array<{ id: string; name: string; file: string; message: string }>; // details via get_failure_details
  selection: { strategy: "full" | "incremental"; reason: string; files: string[] };
}

interface TestPlan {   // returned when dryRun=true
  planId: string; files: string[]; reasoning: string; expiresAt: string;
}
```

## Execution Flows

**Registration** (`test-mcp register`): resolve git-root → ensure `.test-mcp/config.json`
(create `projectId`, `stateDir`) → ensure `.test-mcp/` in `.gitignore` → ensure daemon up
(auto-boot unless `--no-spawn`) → `register_project(path)` → daemon validates the
vitest/vite config, records in registry.

**Run (incremental)**: `run_tests({ projectId, mode: "incremental" })` →
Orchestrator ensures a warm worker for the project → Selection Engine computes the file
set (see below) → worker runs them via the project's Vitest → results persisted to history;
coverage map updated for measured files → `TestResult` returned.

**Dry-run → commit**: `run_tests({ projectId, dryRun: true })` → Selection Engine returns a
`TestPlan` with a cached `planId` → agent inspects → `run_tests({ projectId, planId })`
executes exactly that plan (re-derives if the plan expired).

**Selection algorithm** (Selection Engine, invariant 5):
1. Compute git-changed files (diff vs. base).
2. `A` = Vitest `--changed` static-graph selection.
3. `B` = coverage-map reverse lookup for changed source files, **after excluding
   setup-baseline modules** (see Coverage Engine). A changed setup-baseline module (e.g.
   `i18n.ts`, an `observability` module) is a **full-suite trigger**, not a per-test edge.
4. If any changed file is unknown to the map, or is a setup-baseline module, or belongs to
   a test that could not be measured → run the **full suite**.
5. Otherwise run `A ∪ B`.

> Validated by the coverage-map spike (`spike/coverage-map/FINDINGS.md`) against the
> real target repo: without setup-baseline exclusion, editing a common lib re-runs the
> *entire* suite; with it, incremental selection drops to ~6% (unit) / ~18% (integration)
> of the suite.

## Concurrency & Lifecycle

- **Worker pool**: at most one warm worker per active project (`createVitest({ watch: true })`),
  bounded by `maxConcurrentWorkers` globally. LRU-evict/reap idle workers after
  `workerIdleTtlMs`.
- **Per-project serialization**: a project handles one run at a time; concurrent requests
  for the same project queue.
- **Cancellation**: `run_tests` can be cancelled (client disconnect or explicit) → IPC
  cancel message → `vitest.cancelCurrentRun()`.
- **Crash handling**: a crashed worker is respawned on next request; project status →
  `error` with the captured cause until a successful run.

## Daemon ↔ Worker IPC

`child_process.fork` with JSON messages (versioned):

```typescript
// daemon → worker
type ToWorker =
  | { type: "run"; runId: string; files: string[]; coverage: boolean; allTestsRun: boolean }
  | { type: "cancel"; runId: string }
  | { type: "shutdown" };

// worker → daemon
type FromWorker =
  | { type: "ready" }
  | { type: "progress"; runId: string; completed: number; total: number }
  | { type: "result"; runId: string; result: TestResult; coverageDelta?: CoverageDelta }
  | { type: "error"; runId: string; message: string; stack?: string };
```

`progress` messages map to MCP `notifications/progress` (with a `progressToken`) on the
originating tool call. The final `result` is the authoritative `tools/call` response.

## Coverage Map Build (primary technical risk — spike VALIDATED)

Per `docs/patterns.md` (Coverage-to-Test Mapping): run test files with V8 precise
coverage in a **single pass** (serially in one process), snapshot cumulative coverage
after each file, diff to attribute execution → source→test-file map. Granularity is
**test-file level**. Incremental: hash each test file; re-measure only changed/new files.

Validated by the spike (`spike/coverage-map/FINDINGS.md`) on the real target repo. Two
mandatory refinements came out of it:

1. **Subtract the setup baseline.** `setupFiles` (e.g. `vitest.setup.ts`) run before every
   test, so their transitive imports are attributed to *every* test file (~8–9 modules on
   the target). Measure a setup-only baseline (coverage of a no-op test) once and subtract
   it from each test's attribution; the subtracted modules become full-suite triggers.
   Without this the map is nearly useless (a common-lib edit selects the whole suite).
2. **Single-pass, not per-file.** Naive per-file measurement was ~6× a single combined run
   on the target (77s vs 13s for 22 files); per-file startup dominates. Single-pass keeps
   accuracy while amortizing startup.
3. **Unmeasurable tests are always-run.** Some heavy tests (e.g. AG-Grid-mounting
   `CalendarPage.test.tsx`) exceed the measurement budget under coverage and yield no data.
   Any test the engine cannot measure (timeout/crash/no coverage) is recorded as
   "unknown deps" and **always selected** — never silently dropped.

## Error Taxonomy

Tool errors return structured MCP error responses (never crash the daemon):

- `UnknownProject` — `projectId` not registered.
- `InvalidConfig` — no resolvable vitest/vite config at registration.
- `WorkerFailure` — worker crashed/failed to start (includes cause).
- `PlanExpired` — `planId` no longer cached (client should re-plan).
- `ValidationError` — schema validation of tool input failed.
- `DaemonUnavailable` — CLI-side: cannot reach/boot the daemon.

## Cross-Cutting

- **Logging**: structured logs to stderr (stdout is reserved for stdio JSON-RPC);
  per-run logs retained in history.
- **Versioning/migration**: on load, if a file's `schemaVersion` is older, run a migration;
  unknown newer version → refuse and warn.
- **Testing the tool itself**: unit-test the Selection/Coverage engines with fixtures;
  integration-test the daemon over its HTTP transport; dogfood by registering this repo.

## Open Risks

1. **Coverage-map accuracy/perf** — spike-validated (see above); residual risk is the
   single-pass snapshot-diff implementation and setup-baseline detection holding up across
   projects. Mitigated by the conservative always-run fallback.
2. **Heavy/unmeasurable tests** — coverage instrumentation can push heavy tests past their
   budget (observed on the target's AG-Grid suite). Handled by always-run fallback, but it
   erodes the incremental benefit for suites with many such tests; measurement budget is
   configurable.
3. **Watch-mode memory** under many concurrent projects — bounded by the pool cap + idle TTL;
   revisit limits after real usage.
4. **Vitest advanced-API drift across 3.x/4.x** — pin the version; worker abstracts the
   differences (`runTestFiles` 4.1+ vs `runTestSpecifications` 3.x). Target repo is 4.1.9.
