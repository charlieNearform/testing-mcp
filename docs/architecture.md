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
5. **Correctness over cleverness, with an explicit confidence channel.** Prefer the tightest
   *safe* selection and **report confidence**. When impact is genuinely unbounded (build/test
   config changed, or `related`'s static import graph resolves to zero test files despite a
   real change) → run the **full suite** (this is the ONLY scenario that ever runs more than
   one Vitest pass for a single request — Story 3.8 AC1). When selection is bounded but not
   provably complete (e.g. a new source reachable only via a dynamic import the static graph
   can't see) → run the tight set and mark the result **degraded confidence** with reasons, so
   the caller runs a full pass before relying on it. Never silently skip *without signalling*.
6. **Schemas are versioned.** Every persisted JSON file carries `schemaVersion`.
7. **Exactly one Vitest pass per request, coverage full-suite-only (Story 3.8).** Every
   `run_tests` request — full or incremental — executes exactly one Vitest invocation
   (invariant 5's fallback is the sole exception). A single pass can report an aggregate
   coverage percentage but never per-test attribution, so coverage measurement is available
   only on a genuine full-suite run; an incremental/selective request with `coverage: true`
   is rejected with a structured error, never silently downgraded.

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
                         │  │ (per-project  │   │ (changed-file delta│ │
                         │  │  worker pool) │   │  → Vitest `related`)│ │
                         │  └──────┬────────┘   └─────────┬──────────┘ │
                         └─────────┼───────────────────────┼──────────┘
                                   │ fork + IPC            │ reads/writes
                          ┌────────▼─────────┐    ┌─────────▼──────────┐
                          │ Worker (per proj)│    │ <git-root>/        │
                          │ cwd=projectRoot  │    │   .test-mcp/       │
                          │ project vitest   │    │  (last-run snapshot,│
                          │ createVitest()   │    │   history, config) │
                          └──────────────────┘    └────────────────────┘
```

**Components:**

- **CLI (`test-mcp`)** — thin launcher/client, no Vitest coupling; safe to install
  globally or run via `npx`. Commands: `init`, `register`, `mcp-bridge`, `ui`, `start`,
  `stop`, `status`, `link`, `unlink`.
- **MCP Layer** — `McpServer` + tool registration; Streamable HTTP transport (primary)
  and optional stdio single-project mode. Handles auth, Host/Origin validation, sessions.
- **Project Registry** — central record of registered projects (`projectId` → path,
  configPath, status); persisted in the central dir; rehydrated on daemon start.
- **Orchestrator** — owns the per-project **worker pool**, run queue, cancellation,
  concurrency caps, and idle reaping.
- **Selection Engine** — decides which changed files to hand to Vitest's `related` config
  field for an incremental request (Story 3.8 — retired the reverse coverage map and the
  git-delta/map union it used to compute; a single Vitest pass now resolves affected tests
  via its own static import graph), builds dry-run plans.
- **Worker** — per-project subprocess that resolves and drives the project's own Vitest;
  also measures coverage (full-suite-only, in the SAME pass as the real test results —
  Story 3.8) when requested.

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
- **Per-daemon bearer token**: a **stable** secret so MCP clients can be configured
  statically. Resolved as `TEST_MCP_TOKEN` env override → persisted `config.token` →
  generated once on first start and written back to `~/.test-mcp/config.json` (`0600`). It
  no longer rotates per start. The live token is also mirrored into the `0600`
  `daemon.lock` alongside pid/port; the CLI reads it and injects `Authorization: Bearer
  <token>`. MCP requests without it are rejected. (Host/Origin validation above is the
  primary DNS-rebinding defense; the token is defense-in-depth and stops other local users
  from *driving* the daemon — running tests / mutating state via `/mcp`.)
- **`/ui` and `/health` are intentionally unauthenticated** (loopback + Host/Origin only, no
  bearer). `/ui*` is strictly **read-only** — it lists projects and reports run state, and
  cannot trigger any action the token guards. The trade-off is that it discloses project
  paths and results to any local user; acceptable for the on-machine, single-user model.
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
  "workerIdleTtlMs": 300000,
  "token": "…"                    // stable bearer secret; generated once, TEST_MCP_TOKEN overrides
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

> **Coverage map — retired (Story 3.8).** `<git-root>/.test-mcp/coverage-map.json` (and its
> sibling per-test-file combined-coverage data file, Story 6.10) no longer exist. A single
> Vitest pass can report an aggregate coverage percentage but never per-test attribution
> (which test covers which source) — that required measuring test files separately, which
> "exactly one Vitest pass, every run" (invariant 7) now forbids. Coverage is full-suite-only,
> produced by the SAME pass that runs the tests (see "Coverage Map Build" below, retitled).

**Last-run snapshot** (repo, `<git-root>/.test-mcp/last-run-snapshot.json`, git-ignored) —
`{ schemaVersion, takenAt, files: { <relpath>: <sha256> } }`. The default incremental baseline:
the next run's changed set is computed against it. Advanced **only for validated (actually-run)**
files after a run, so a changed-but-unrun file is never hidden from the next delta.

**Test inventory** (repo, `<git-root>/.test-mcp/test-inventory.json`, git-ignored) —
`{ schemaVersion, files: { <relpath>: string[] } }`, mapping each test file to the test names
last seen in it. Reconciled per-file from `result.selection.files`/`result.tests` after every
run (skipped when `testsTruncated`), so it self-heals additions and deletions without depending
on the capped run-history depth. Powers the monitoring UI's `totalTests` figure — the sum of
every file's cached test-name-set size, unaffected by history aging out.

**Ignore file** (repo, `<git-root>/.test-mcp-ignore`, optional) — gitignore-style patterns
excluded from the changed set (on top of the built-in non-code default filter).

**Run history** — an **in-memory** ring buffer in the daemon (newest first, capped per
project) holding each completed run: id, timestamps, duration, status, selection (strategy +
files + reason), counts, and failure details. Served to the monitoring UI
(`/ui/api/projects/:id/runs` and `/ui/api/projects/:id/runs/:runId`). It resets on daemon
restart; **on-disk** persistence (`<git-root>/.test-mcp/history/*.json`) is still planned.

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
| `run_tests` | `{ projectId, mode?, coverage?, since?, files?, suite?, dryRun?, planId? }` | `TestResult` \| `TestPlan` |
| `get_test_status` | `{ projectId }` | `{ state, progress?, lastResult?, lastError?, updatedAt?, watch? }` |
| `start_watch` | `{ projectId }` | `WatchStatus` |
| `stop_watch` | `{ projectId }` | `{ stopped }` |
| `get_failure_details` | `{ projectId, failureId }` | `{ name, file, message, stack, expected?, actual?, diff? }` |

```typescript
interface TestResult {
  success: boolean; summary: string; duration: number;
  total: number; passed: number; failed: number; skipped: number;
  failures: Array<{ id: string; name: string; file: string; message: string }>; // details via get_failure_details
  selection: { strategy: "full" | "incremental"; reason: string; files: string[] };
  confidence?: { level: "high" | "degraded"; reasons: string[] }; // degraded ⇒ run a full pass before relying on completeness
  // Full-suite only (Story 3.8) — one native Vitest pass, produced in the SAME pass as the
  // results above. Absent on an incremental/selective run; `coverage: true` there is rejected
  // with a ValidationError instead (never silently downgraded).
  coverage?: { total: CoveragePct; files: Array<{ file: string } & CoveragePct>; confidence?: Confidence;
    thresholds?: Partial<CoveragePct>; thresholdsMet?: boolean };
  metadata?: { wallClockMs: number; testExecMs: number; overheadMs: number; isolate: boolean };
}
// `since?: "last-run" | "head"` selects the incremental baseline (default "last-run").

interface TestPlan {   // returned when dryRun=true
  planId: string; projectId: string; strategy: "full" | "incremental";
  files: string[]; reasoning: string; createdAt: string; expiresAt: string;
  metadata: { latencyMs: number };
}
```

## Execution Flows

**Registration** (`test-mcp register`): resolve git-root → ensure `.test-mcp/config.json`
(create `projectId`, `stateDir`) → ensure `.test-mcp/` in `.gitignore` → ensure daemon up
(auto-boot unless `--no-spawn`) → `register_project(path)` → daemon validates the
vitest/vite config, records in registry.

**Run (incremental)**: `run_tests({ projectId, mode: "incremental" })` →
Orchestrator ensures a warm worker for the project → Selection Engine computes the changed-file
list to feed Vitest's `related` config field (see below) → worker runs ONE Vitest pass (real
results; coverage never requested here, see invariant 7) → results persisted to history →
`TestResult` returned.

**Dry-run → commit**: `run_tests({ projectId, dryRun: true })` → Selection Engine returns a
`TestPlan` with a cached `planId` → agent inspects → `run_tests({ projectId, planId })`
executes exactly that plan (re-derives if the plan expired).

**Selection algorithm** (Selection Engine, invariant 5, simplified/unified in Story 3.8):
0. **Filter** provably test-irrelevant paths from the changed set — non-code files
   (docs/markdown, VCS/editor/agent dotfiles) and any patterns in the project
   `.test-mcp-ignore` (gitignore-style). These never drive selection.
1. **Changed set** = files changed vs the **last-run snapshot** (default; content-hash) or vs
   git HEAD (`since: "head"`), including **added / modified / deleted**.
2. **Only test files changed** → feed them into `related` directly (AC1): provably complete,
   no source-side dependency-graph uncertainty possible.
3. **Any changed source** → feed the WHOLE changed-file set (sources + tests) into Vitest's
   `related` config field — an explicit file list resolved through Vitest's own static import
   graph, confirmed live to skip Vitest's own git lookup entirely (see the `related` mechanism
   note below). This is the SAME single Vitest pass that then runs the resolved tests, never a
   second one.
4. **Unbounded → full suite:** build/test config change (`package.json`, lockfiles,
   `*.config.*`, `tsconfig*.json`, `vitest.setup.*`), no git/static graph, the changed-file
   list's size relative to the project's known test-file count exceeds a threshold (size-based
   full-run escalation), or `related` resolves to zero test files despite a real, non-empty
   changed input (the ONLY scenario that runs Vitest twice for one request — AC1's sole
   exception).
5. **Confidence:** high by default; **degraded** only for a NEW (untracked) source that might be
   reachable solely through a dynamic `import()`/`require(...)` the static graph can't see
   (AC6) — the one residual blind spot once there's no runtime-measured map to fall back on. A
   MODIFIED source has no analogous gap; `related`'s static graph resolves it directly.

> **The `related` mechanism (Story 3.8, verified live):** Vitest's `UserConfig.related` field,
> when set, makes Vitest skip its own git-based `changed: true` lookup entirely and resolve
> dependents via the static import graph against exactly the given file list — unlike
> `changed: true`, which does its own git diff and has no memory of what a prior test-mcp run
> already validated (confirmed live to re-select an already-validated file the moment a second,
> unrelated file is edited without committing either). `related` is fed from the orchestrator's
> existing since-last-run snapshot delta (unchanged mechanism, Story 6.7).

## Concurrency & Lifecycle

- **Worker model** *(current)*: the orchestrator **cold-forks a fresh worker per run** and
  kills it when the run settles. Total concurrent workers across all projects are bounded by
  a global semaphore sized to `maxConcurrentWorkers`.
- **Per-project serialization**: a project handles one run at a time; concurrent requests
  for the same project queue.
- **Crash handling**: a worker that crashes/exits before returning fails the run with
  `WorkerFailure` and sets project status → `error`; the next request forks a fresh worker.
- **Planned (not yet implemented)**: a *warm* per-project pool
  (`createVitest({ watch: true })`) with LRU/idle reaping after `workerIdleTtlMs`, and
  in-flight **cancellation** on client disconnect (IPC `cancel` → `vitest.cancelCurrentRun()`).
  The `cancel` IPC message and `workerIdleTtlMs` config exist but are inert today.

## Daemon ↔ Worker IPC

`child_process.fork` with JSON messages (versioned):

```typescript
// daemon → worker
type ToWorker =
  | { type: "run"; runId: string; projectId: string; files: string[]; coverage: boolean; relatedFiles?: string[] }
  | { type: "cancel"; runId: string }   // defined but not yet handled by the worker
  | { type: "shutdown" };

// worker → daemon
type FromWorker =
  | { type: "ready" }
  | { type: "progress"; runId: string; completed: number; total: number }
  | { type: "result"; runId: string; result: TestResult; failureDetails?: FailureDetail[] }
  | { type: "error"; runId: string; message: string; stack?: string };
```

`relatedFiles` (Story 3.8): present + non-empty means a related-based incremental selection,
fed straight into Vitest's `related` config field; absent means a full suite or an explicit
`files` selection. There is no more `"phase-progress"` message — the unified single pass
reports through the ordinary `progress`/`case-start`/`case-result` messages like any other
run, so there is no separate blind coverage phase left to heartbeat.

Both ends validate the received message with Zod at the process boundary (`parseToWorker` /
`parseFromWorker`) and reject malformed messages rather than acting on garbage fields.

`progress` messages map to MCP `notifications/progress` (with a `progressToken`) on the
originating tool call. The final `result` is the authoritative `tools/call` response.

## Coverage Map Build (retired — Story 3.8)

**Retired (Story 3.8).** This section described a source→test-file reverse map built by
measuring V8 coverage per test file. That entire mechanism — the map itself, per-file
measurement, setup-baseline subtraction, unmeasurable-tests tracking, and the per-test
combined-coverage union/staleness machinery (Story 6.10) — is deleted, not merely superseded:

- **Why:** investigating incremental's remaining double-Vitest-pass violation (a
  `coverage: true` incremental request still did `1 + N` invocations — a real-results pass
  plus one per selected file) surfaced that a single Vitest pass can produce an aggregate
  coverage **percentage** for any file set, but never **per-test attribution** — that requires
  measuring test files separately, which "exactly one Vitest pass, every run, no exceptions"
  (invariant 7) now forbids outright. So this wasn't just a double-pass fix; it retired
  per-test attribution entirely, confirmed against a real AI-agent workflow trace (fast
  incremental loop with no coverage, coverage only on a terminal full-suite gate — no real
  usage pattern needs incremental coverage).
- **What replaced it:** the Selection Engine no longer needs the map at all — an incremental
  request's changed-file list is fed directly into Vitest's own `related` config field (see
  "Selection algorithm" above and the `related` mechanism note), which resolves affected
  tests via the static import graph in the SAME pass that runs them. Coverage is measured
  only on a genuine full-suite run, in that SAME single pass (no more two-phase
  results-then-coverage design) — see `src/worker/index.ts`'s `runWithCoverage`.
- **What survives unchanged:** the setup-baseline concern itself is a non-issue without
  custom logic — a live experiment during this story's investigation confirmed Vitest's own
  dependency graph already resolves a `setupFiles` entry's dependents correctly when passed to
  `related` (a 2-test-file fixture where only `vitest.config.ts`'s `setupFiles`, not a direct
  import, connected them selected BOTH test files, not zero). The since-last-run snapshot
  mechanism (Story 6.7) and the size-based full-run escalation (this cycle) are both
  orthogonal to the map and unchanged.
- **Epic 7 alignment:** `epics.md`'s Runner Plugin API stories (7.1, 7.3, 7.6 — not yet
  implemented) have been annotated to expect an explicit file list (mirroring `related`, not a
  git ref) and a `capabilities.coverage: "summary"` shape, so that epic's eventual extraction
  lifts this story's `related`-based resolution and unified coverage mechanism with minimal
  reshaping.

## Error Taxonomy

Tool errors return structured MCP error responses (never crash the daemon):

- `UnknownProject` — `projectId` not registered.
- `InvalidConfig` — no resolvable vitest/vite config at registration.
- `WorkerFailure` — worker crashed/failed to start (includes cause).
- `PlanExpired` — `planId` no longer cached (client should re-plan).
- `ValidationError` — schema validation of tool input failed, or (Story 3.8 AC2) `run_tests`
  was called with `coverage: true` on a request that didn't resolve to a genuine full-suite run.
- `DaemonUnavailable` — CLI-side: cannot reach/boot the daemon.
- `NotImplemented` — a tool was invoked before its backing subsystem was wired in
  (internal guard; not expected in a fully-initialized daemon).

## Cross-Cutting

- **Logging**: structured logs to stderr (stdout is reserved for stdio JSON-RPC).
  (Per-run history persistence is planned — see Data Model.)
- **Versioning/migration**: on load, if a file's `schemaVersion` is older, run a migration;
  unknown newer version → refuse and warn.
- **Testing the tool itself**: unit-test the Selection/Coverage engines with fixtures;
  integration-test the daemon over its HTTP transport; dogfood by registering this repo.

## Open Risks

1. ~~**Coverage-map accuracy/perf**~~ — **Closed, not merely resolved (Story 3.8, 2026-07-27).**
   Story 3.7 resolved this risk for the full-suite case (one native Vitest pass instead of
   per-file attribution) but explicitly left it "residual, not closed" for the
   incremental/selective path's per-test-file measurement mechanism. Story 3.8 closes that
   residual scope by deleting the mechanism entirely: there is no more reverse coverage map,
   no more per-file measurement, and no more incremental/selective coverage at all (coverage is
   full-suite-only, AC2). A future broad refactor touching many files at once now costs exactly
   what its `related`-resolved test selection costs to run — never an added per-file
   measurement pass — because there is no such pass left to pay for.
2. ~~**Heavy/unmeasurable tests**~~ — **Moot (Story 3.8).** This risk was specifically about
   coverage instrumentation pushing heavy tests past a per-file measurement budget; with no
   more per-file measurement anywhere, there is no budget to exceed. A heavy test still runs
   (and is measured for coverage) normally as part of whichever single Vitest pass includes it.
3. **Watch-mode memory** under many concurrent projects — bounded by the pool cap + idle TTL;
   revisit limits after real usage.
4. **Vitest advanced-API drift across 3.x/4.x** — pin the version; worker abstracts the
   differences (`runTestFiles` 4.1+ vs `runTestSpecifications` 3.x). Target repo is 4.1.9.
5. **`related`'s own blind spots beyond dynamic imports** — Story 3.8's live experiments
   confirmed `related` correctly resolves direct static imports and `setupFiles` entries, and
   correctly falls back to full on a genuine orphan. Anything else Vitest's static import-graph
   analysis itself might miss (e.g. non-standard module resolution, unusual bundler-specific
   syntax) is now this system's only remaining selection blind spot, since there is no more
   runtime-measured map to catch what the static graph can't see.
