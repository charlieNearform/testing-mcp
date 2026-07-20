# Code Review — Epic 8: Async Execution & Observability

**Reviewed:** commit `3246e24` ("feat(daemon): async run_tests, live test progress, log tail, stall watchdog (Epic 8)"), diffed against its parent `3246e24^`.
**Context:** this commit implements all 7 stories of Epic 8 (8.1–8.7) at once. It was never run through the normal per-story `bmad-code-review` cycle, and no individual story files exist for 8.1–8.7 — this report stands in for that gap.
**Spec:** `_bmad-output/planning-artifacts/architecture/architecture-epic-8-async-execution-observability-2026-07-17/ARCHITECTURE-SPINE.md` (AD-17–AD-21), `_bmad-output/planning-artifacts/epics.md` (Epic 8, stories 8.1–8.7).
**Review layers:** Blind Hunter (adversarial), Edge Case Hunter, Acceptance Auditor. All findings below were re-verified against the actual source before rating.

## Review Findings

### Decision needed

Both resolved by the user (2026-07-20) — see resolutions folded into Patch below.

### Patch — all applied 2026-07-20

- [x] [Review][Patch] **[Resolved decision]** Provisional stall watchdog now arms at `staleTestGraceMs` alone (AD-20) for the window before ANY worker message has arrived, via a `hasHeardFromWorker` flag; once heard from (config or any progress signal), reschedules use `effectiveTestTimeoutMs + staleTestGraceMs` as before. `DEFAULT_UNKNOWN_TEST_TIMEOUT_MS` changed from an arbitrary `30_000` to `5_000` (Vitest's own actual default `testTimeout`), and a `MAX_SANE_TEST_TIMEOUT_MS` ceiling (30min) was added alongside the existing floor. [src/orchestrator/index.ts:97-113,619-659]
- [x] [Review][Patch] **[Resolved decision]** `get_test_status` now accepts an optional `runId`; if supplied and it doesn't match the project's currently-tracked `RunStatus.runId`, it responds `{state:"queued", runId}` instead of exposing a different run's state/result. Both tools' descriptions document the pattern. [src/mcp/server.ts]
- [x] [Review][Patch] `get_test_status`/UI live payload now matches AD-21's shape — `getLiveRun()` returns `log` (was `logTail`), plus `phase` (populated from `phase-progress` messages) and `lastProgressAt`. [src/orchestrator/index.ts:78-89,844-869]
- [x] [Review][Patch] `effectiveWaitMs` now chains project/daemon defaults with explicit `!== undefined` checks (not `??`), so an explicit `null` ("wait forever") at any layer is respected instead of falling through. [src/mcp/server.ts]
- [x] [Review][Patch] `run_tests`'s race timer is now cancelled via `clearTimeout` regardless of which side of the `Promise.race` wins. [src/mcp/server.ts]
- [x] [Review][Patch] `readProjectDefaultRunWaitMs` is now async (`fs.promises.readFile`) and validated with the new shared `ProjectLocalConfigSchema` (Zod) instead of a bare type assertion. [src/mcp/server.ts, src/types/contracts.ts]
- [x] [Review][Patch] Empty-selection short-circuit run now sets a fresh `liveRuns` entry for its own `runId` before completing, so `get_test_status`'s `live` field no longer shows a stale previous run. [src/orchestrator/index.ts]
- [x] [Review][Patch] `finish()` now also calls `child.stdout?.removeAllListeners()` / `child.stderr?.removeAllListeners()` alongside `child.removeAllListeners()`. [src/orchestrator/index.ts]
- [x] [Review][Patch] `appendLog` now uses a per-stream `node:string_decoder` `StringDecoder` instead of `chunk.toString("utf8")`, so a multi-byte UTF-8 character split across two `data` events decodes correctly. [src/orchestrator/index.ts]
- [x] [Review][Patch] UI's `/log/events` SSE stream now tracks the run's `runId`; on a run change it sends `{log, replace:true}` and the client replaces instead of appends, eliminating the transient duplication. [src/ui/index.ts]
- [x] [Review][Patch] `waitMs` tool-input schema now has `.nonnegative()`. [src/mcp/server.ts]
- [x] [Review][Patch] `ProjectLocalConfig` is now a single shared Zod schema/type (`ProjectLocalConfigSchema` in `src/types/contracts.ts`), used by both `cli/main.ts` and `mcp/server.ts`. [src/types/contracts.ts, src/cli/main.ts, src/mcp/server.ts]
- [x] [Review][Patch] `armWatchdog` now clamps `testTimeoutMs` to both a floor and a new `MAX_SANE_TEST_TIMEOUT_MS` ceiling. [src/orchestrator/index.ts]
- [x] [Review][Patch] Renamed the misleading test to describe its actual assertion (200, not 404) and extended it to also cover `/log/events` for an unknown project. [test/ui-live.test.ts]
- [x] [Review][Patch] Widened margins in the stall-watchdog tests (grace 30-50ms → 100-150ms, sleeps scaled proportionally) and added two tests directly covering the provisional-watchdog fix (kills fast with no worker messages at all; falls back to the default-unknown threshold once any message arrives without `config`). `orchestrator-live-run.test.ts` already uses self-correcting poll loops rather than fixed-sleep races, so no change was needed there. [test/orchestrator-stall-watchdog.test.ts]

**Incidental fix required to keep tests green:** the new `/log/events` unknown-project test (above) surfaced a pre-existing gap — neither SSE route (`/ui/events`, `/log/events`) had a `res.on("error", ...)` handler, so an abrupt client disconnect raised an unhandled async error event. Added a no-op error handler to both routes (belt-and-suspenders with the existing `try/catch` around `res.write()`, which only catches synchronous throws). [src/ui/index.ts]

**Pre-existing flake found, NOT fixed (out of scope):** `pnpm test` intermittently fails a `total`-count assertion in `test/worker-run.test.ts`/`test/plan-commit.test.ts` (both share `test-fixtures/sample-project`) when run as part of the full suite; reproduced on a clean pre-Epic-8 checkout too, so unrelated to this review. Logged in `deferred-work.md`.

### Deferred

- [x] [Review][Defer] Missing regression test for Story 8.5's own testing note: no test asserts that log-only worker activity (stdout/stderr, no test-level progress) does not reset/block the stall watchdog. Production code path (`appendLog`) looks correct — never calls `touchLiveProgress` — but the mandated guard test was never written. [test/orchestrator-stall-watchdog.test.ts] — deferred, pre-existing test-coverage gap, not a behavior bug
- [x] [Review][Defer] Story 8.3's testing note ("`startDaemon()` threads `staleTestGraceMs` into the constructed `Orchestrator`") isn't asserted end-to-end in `test/daemon.test.ts` — only the config defaults themselves are tested; code is correct. [test/daemon.test.ts:106-121] — deferred, test-coverage gap only

## Dismissed (verified, not defects)

- Every `run_tests` call now pays for an extra Vitest config-discovery startup even without coverage (`readResolvedRunConfig` is unconditional in `handleRun`) — this is AD-20's explicit, spec-mandated requirement (the watchdog needs `testTimeout` on every run), not an oversight.
- `run_tests`'s synchronous-by-default contract becomes async-by-default via `defaultRunWaitMs: 10_000` — this is exactly what AD-17/Story 8.6 specify. Operationally significant (every existing MCP integration must now handle a job-handle response or explicitly pass `waitMs: null`) but working as designed.
- Unthrottled `notifyStatusChange()` broadcast on every test/log event — explicitly named in the architecture spine's own "Deferred" section as a known, ratified follow-up, not new debt from this review.
- Mismatched-`runId` `config`/`case-start`/`case-result`/`phase-progress` messages are silently dropped with no diagnostic (asymmetric vs. `result`/`error`, which fail the run) — AD-18 explicitly mandates silent discard here; the asymmetry is intentional, not a gap.

**Dismiss count:** 4
