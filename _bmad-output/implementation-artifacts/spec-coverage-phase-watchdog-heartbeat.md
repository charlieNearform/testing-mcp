---
title: 'Heartbeat coverage-measurement phases so the stall watchdog stops killing slow coverage runs'
type: 'bugfix'
created: '2026-07-22'
status: 'done'
review_loop_iteration: 1
context: []
baseline_commit: 'd9677a48bd852e35938cf6c4281b1ad3800a5e4c'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** When `run_tests` runs with coverage, `buildAndPersistCoverageMap` re-runs each test file individually (silent reporter) to build the reverse coverage map; a single file's own measurement can take well over a minute. The orchestrator's stall watchdog (armed at `testTimeout + staleTestGraceMs`, tuned for per-test timing) only gets reset by a `phase-progress` message sent *after* a file finishes — so any file whose own measurement outlasts that threshold gets the whole worker killed mid-measurement. There's also a silent gap before the first heartbeat, during file discovery and setup-baseline measurement, neither of which sends any progress signal today.

**Approach:** Mirror the existing, already-proven `withPoolStartHeartbeat` pattern (used for slow Vitest-pool worker starts): heartbeat every long, silent wait in the coverage-measurement path with periodic `phase-progress` messages carrying the *unchanged* `completed` count, so the orchestrator's existing `touchLiveProgress()` handling keeps the watchdog satisfied throughout. No orchestrator changes.

## Boundaries & Constraints

**Always:**
- Reuse the existing `phase-progress` IPC message shape (`{type:"phase-progress", runId, phase:"coverage", completed, total}`) — no new message type.
- A heartbeat's `completed` value is never incremented ahead of real completion — it only re-signals "still on file N of M."
- Every heartbeat `send()` is guarded (try/catch), matching `withPoolStartHeartbeat`.
- The first heartbeat for each heartbeated wait fires immediately, not on the first interval tick — the orchestrator's provisional pre-worker-message watchdog phase uses `staleTestGraceMs` alone (default 5s), which a first-tick delay could burn through.
- Any heartbeat timer is cleared in a `finally` once its wrapped operation settles.
- The heartbeat max-duration cap must scale with `TEST_MCP_MEASURE_BUDGET_MS` (`budgetMs`), never be a fixed constant disconnected from it (see Spec Change Log): compute `Math.max(COVERAGE_HEARTBEAT_MAX_MS, budgetMs + COVERAGE_HEARTBEAT_INTERVAL_MS)` once per `buildAndPersistCoverageMap` call and pass it to every `withCoverageHeartbeat` call (discovery, baseline, per-file alike) — raising the one user-facing knob for slow coverage measurement must also raise the heartbeat's own safety margin. `COVERAGE_HEARTBEAT_MAX_MS` is only the floor for a small/default budget, never the sole ceiling. A genuinely wedged call still eventually stops being heartbeated and falls through to the orchestrator's normal stall detection instead of hanging forever.
- The baseline-measurement heartbeat's `total` must be `targetTestFiles.length` (the already-resolved file count at that point in the function), never the raw `files` parameter — in discovery mode (`files=[]`) `files.length` is always `0`, which would report a wrong, stale total on a value the orchestrator surfaces as user-visible live progress, not just an internal watchdog signal.
- The two test-only override params on `buildAndPersistCoverageMap` (`startVitestOverride`, `createVitestOverride`) must be guarded, but *not* by a blanket "both or neither" rule — `startVitest` is always needed (setup-baseline measurement always runs) so `createVitestOverride` without `startVitestOverride` is always a mismatch; `createVitest` is only needed when `files=[]` (discovery), so `startVitestOverride` alone is legitimate whenever an explicit file list is given. Throw a clear error only for the genuinely-mismatched combinations, so a call that only needs one override isn't forced to fake the other just to satisfy the guard.

**Ask First:** none anticipated — this closely mirrors an already-approved fix in this codebase. If a genuinely new architectural question arises, halt and ask.

**Never:**
- Do not add a coverage-phase-specific watchdog threshold in the orchestrator as an alternative to heartbeating — this project already chose worker-side heartbeating over widening orchestrator thresholds for the analogous pool-start-retry fix.
- Do not change the existing per-file `TEST_MCP_MEASURE_BUDGET_MS` cap/fallback, or when/whether coverage is enabled for the main run.
- Do not restructure, eliminate, or further cache the second (per-file) coverage-measurement pass. It is required to build the reverse source→test coverage map (Story 3-2) powering incremental test selection — a single combined-coverage run cannot produce that per-file attribution. This "double run" is a deliberate, existing tradeoff, not a bug; its cost already scales with run scope (cheap incremental runs, expensive only for full-suite coverage builds) — out of scope here.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Single slow file (e.g. 127s) | coverage-enabled run, one file's measurement is slow | Heartbeats keep `live.lastProgressAt` fresh throughout; file completes normally, real phase-progress follows | N/A |
| Slow discovery / baseline measurement | `files=[]` (full run) | Heartbeats fire during these steps too, closing the pre-loop silent gap | N/A |
| Heartbeat send on a torn-down IPC channel | channel closes mid-heartbeat | Failure caught, swallowed | try/catch per send |
| Genuinely wedged discovery/baseline (never resolves) | fake `startVitest` hangs forever | Heartbeating stops after the budget-aware max-duration cap; call left to resolve on its own | matches `withPoolStartHeartbeat`'s own documented tradeoff |
| `TEST_MCP_MEASURE_BUDGET_MS` raised above the default | operator sets e.g. `300000` to allow slower per-file measurement | The heartbeat cap rises with it (`budgetMs + interval`), so heartbeating doesn't cut off before the file's own configured allowance is reached | N/A |
| Mismatched DI overrides in a test | only `startVitestOverride` provided, `files=[]` (discovery needed) | Throws a clear error immediately instead of silently running real Vitest against the fixture dir | thrown synchronously before any heartbeat/measurement work starts |

</frozen-after-approval>

## Code Map

- `src/worker/index.ts` -- `withPoolStartHeartbeat`/`POOL_START_HEARTBEAT_*` (pattern to mirror), `measureCoverage`, `discoverTestFiles`, `measureSetupBaseline`, `buildAndPersistCoverageMap`, `withTimeout`, `runVitest` (existing `startVitestOverride`/DI precedent).
- `src/orchestrator/index.ts` -- `phase-progress` handling (`touchLiveProgress()`), unchanged; read-only reference.
- `test/worker-pool-retry.test.ts` -- existing test pattern for heartbeat-during-a-long-wait (in-process, `process.send` stub, fake slow dependency) to mirror.

## Tasks & Acceptance

**Execution:**
- [x] `src/worker/index.ts` -- add `COVERAGE_HEARTBEAT_INTERVAL_MS` (4000) and `COVERAGE_HEARTBEAT_MAX_MS` (130_000, now a *floor*, not the sole ceiling) near the existing pool-start heartbeat constants.
- [x] `src/worker/index.ts` -- `withCoverageHeartbeat<T>(runId, completed, total, maxMs, attempt)` takes the cap as a parameter (not a fixed module constant) so callers can pass a budget-aware value; immediate heartbeat, then interval-based, capped at `maxMs`, guarded, cleared in `finally`.
- [x] `src/worker/index.ts` -- in `buildAndPersistCoverageMap`, compute `const heartbeatMaxMs = Math.max(COVERAGE_HEARTBEAT_MAX_MS, budgetMs + COVERAGE_HEARTBEAT_INTERVAL_MS);` once (`budgetMs` moved earlier so it's available) and pass it to all three `withCoverageHeartbeat` calls below.
- [x] `src/worker/index.ts` -- wrap the `discoverTestFiles(createVitest)` call (`files.length === 0` branch) with `withCoverageHeartbeat(runId, 0, 0, heartbeatMaxMs, ...)`.
- [x] `src/worker/index.ts` -- wrap the `measureSetupBaseline(startVitest, cwd)` call with `withCoverageHeartbeat(runId, 0, targetTestFiles.length, heartbeatMaxMs, ...)` -- **not** `files.length` (bad_spec fix: see Spec Change Log).
- [x] `src/worker/index.ts` -- wrap the existing `withTimeout(measureCoverage(...), budgetMs, fallback)` call inside `buildCoverageMap`'s `measure` callback with `withCoverageHeartbeat(runId, coverageFilesDone, targetTestFiles.length, heartbeatMaxMs, ...)`. The existing post-await `coverageFilesDone += 1; send(...)` completion signal is unchanged (guarded -- see Design Notes).
- [x] `src/worker/index.ts` -- add optional `startVitestOverride`/`createVitestOverride` params to `buildAndPersistCoverageMap` (mirroring `runVitest`'s existing override pattern). Export `buildAndPersistCoverageMap` for direct test use.
- [x] `src/worker/index.ts` -- guard against a genuinely-mismatched override combination (not a blanket "both or neither" -- see amended Boundaries): `createVitestOverride` without `startVitestOverride` always throws (setup-baseline always runs); `startVitestOverride` without `createVitestOverride` throws only when `files=[]` (discovery will run).
- [x] `test/worker-coverage-heartbeat.test.ts` -- convert the real-9000ms-`setTimeout` tests to `vi.useFakeTimers()`/`advanceTimersByTimeAsync`, matching the cap test's already-deterministic approach -- removes real-timer flakiness risk and cuts the file's real run time from ~36s to ~0.25s.
- [x] `test/worker-coverage-heartbeat.test.ts` -- discriminate the per-file test's baseline-vs-real-measurement phase by inspecting which file `startVitest` was called with (the baseline's own synthetic filename), not by an unenforced call-order assumption.
- [x] `test/worker-coverage-heartbeat.test.ts` -- document the never-resolving `void buildAndPersistCoverageMap(...)` call in the cap test as an intentional, bounded pending promise (no cancellation path exists to invoke).
- [x] `test/worker-coverage-heartbeat.test.ts` -- add tests for: the mismatched-override guard (both directions), the legitimate single-override case NOT throwing, and the heartbeat cap rising with a raised `TEST_MCP_MEASURE_BUDGET_MS`.

**Acceptance Criteria:**
- Given a coverage-enabled run where one file's measurement takes longer than `testTimeout + staleTestGraceMs`, when that file is being measured, then the orchestrator's live view keeps advancing (`lastProgressAt` updates) and the worker is not killed for that file.
- Given `files=[]` (full run) and a slow `discoverTestFiles`/`measureSetupBaseline`, when either is in flight, then heartbeats are sent before the first real per-file phase-progress, and the baseline heartbeat's `total` matches the real discovered file count.
- Given a heartbeat fires on a closed IPC channel, when `send()` throws, then the worker does not crash.
- Given `TEST_MCP_MEASURE_BUDGET_MS` is raised well above 130s, when a per-file measurement runs close to that raised budget, then heartbeats continue for at least that long.
- Given only one of the two DI override params is passed, when `buildAndPersistCoverageMap` is called, then it throws immediately rather than silently touching real Vitest.

## Spec Change Log

**Iteration 1 (bad_spec loopback, triggered by parallel Blind Hunter + Edge Case Hunter review of the first implementation):**
- **Finding:** `COVERAGE_HEARTBEAT_MAX_MS` was specified as a fixed 130_000ms constant "mirroring the pool-start precedent," independent of `TEST_MCP_MEASURE_BUDGET_MS` (`budgetMs`, default 120_000ms). Both reviewers independently flagged this: it sits almost exactly at the "well over a minute" (127s, from the real bug report) scenario this whole fix targets, and `discoverTestFiles`/`measureSetupBaseline` have no timeout of their own at all, making 130s their *only* ceiling with no way for an operator to raise it. Root cause was in the frozen "Always" boundary itself (the spec directed a fixed shared cap), so this is bad_spec, not a trivial implementation slip.
  - **Amended:** the cap is now computed per-call as `Math.max(COVERAGE_HEARTBEAT_MAX_MS, budgetMs + COVERAGE_HEARTBEAT_INTERVAL_MS)` and threaded through `withCoverageHeartbeat` as a parameter, so raising the one existing operator-facing knob (`TEST_MCP_MEASURE_BUDGET_MS`) also raises the heartbeat's own safety margin for every heartbeated step, not just the already-independently-bounded per-file measurement.
  - **Known-bad state avoided:** an operator raising `TEST_MCP_MEASURE_BUDGET_MS` to legitimately tolerate slower per-file measurement would have silently walked right back into the original bug at a higher threshold.
- **Finding (folded into the same iteration):** the baseline-measurement heartbeat used `files.length` (the raw input parameter, `0` whenever discovery runs) instead of `targetTestFiles.length` (the already-resolved real count) as its `total`. Both reviewers caught this independently. The original task spec explicitly specified `files.length`, so this is also bad_spec rather than an implementation error.
  - **Amended:** task now specifies `targetTestFiles.length`.
  - **Known-bad state avoided:** the live-progress view showing `total: 0` during baseline measurement on every discovery-mode (full) run -- user-visible, not just internal.
- **KEEP (verified correct, must survive re-derivation):** the overall `withCoverageHeartbeat` shape (immediate fire, interval, guarded `send()`, cleared in `finally`); wrapping all three of discovery/baseline/per-file; the DI override params + `export` on `buildAndPersistCoverageMap`; guarding the pre-existing per-file completion `send()` (found and fixed in iteration 0, unrelated to this loopback's root cause); the overall test file structure and the real end-to-end sanity check methodology.
- **Also applied this iteration (patch-category findings, not requiring a loopback but implemented alongside the amendment):** throw on mismatched DI overrides; convert two real-timer tests to fake timers; split the ordering-dependent combined test into two; document the intentional pending-promise in the cap test.

## Design Notes

`withCoverageHeartbeat` differs from `withPoolStartHeartbeat` only in payload shape (`phase-progress` + `completed`/`total` vs `config` + `testTimeoutMs`) and is kept as a separate function rather than generalizing the two — they're heartbeating conceptually different signals, and forcing one shared abstraction now would cost more clarity than the ~15 duplicated lines save.

**Found during test-writing, fixed in the same pass:** the existing per-file completion `send({type:"phase-progress",...})` (right after `coverageFilesDone += 1`) was unguarded. On a torn-down IPC channel it throws uncaught, `handleRun`'s `.catch()` then tries its OWN `send({type:"error",...})` on the same dead channel, which also throws -- an unhandled rejection instead of the worker just losing that one signal. Wrapped in try/catch, matching every other `send()` in this file (including the new heartbeats). Small, directly adjacent, and exercised by this spec's own tests, so fixed here rather than deferred.

## Verification

**Commands:**
- `pnpm run typecheck` / `pnpm run build:compile` -- exit 0
- `pnpm exec vitest run test/worker-coverage-heartbeat.test.ts` -- 8/8 pass, ~0.25s (all fake-timer driven)
- `pnpm test` -- full suite exit 0, run 3 consecutive times after the iteration-1 fixes landed (311/311 each time) -- specifically re-checked because a review pass reported inconsistent full-suite results (unrelated files) against an earlier version of this diff that still used real 9s timers; could not reproduce after converting to fake timers.
- Real end-to-end sanity check (not committed): ran the real `Orchestrator` + a real forked worker against a small fixture with `testTimeout:15000` and one test sleeping 9s, coverage enabled. Polled `orch.getLiveRun()` during the run and observed `live.phase = {phase:"coverage", completed:0, total:1}` at t=9.5s, well before the run's ~18.5s total completion -- confirms the heartbeat reaches the real IPC/live-view path, not just the in-process fakes. Re-ran after the iteration-1 fixes with the same result.

## Suggested Review Order

**The budget-aware heartbeat cap (the bad_spec fix)**

- Entry point: the cap is now computed from the operator-configurable budget, not a fixed constant borrowed from an unrelated fix.
  [`worker/index.ts:773`](../../src/worker/index.ts#L773)

- `withCoverageHeartbeat` takes the cap as a parameter instead of reading a module constant directly.
  [`worker/index.ts:185`](../../src/worker/index.ts#L185)

- `COVERAGE_HEARTBEAT_MAX_MS` is now documented as a floor, not the sole ceiling.
  [`worker/index.ts:164`](../../src/worker/index.ts#L164)

**The baseline-total bug (also bad_spec)**

- Baseline heartbeat now reports the resolved file count, never the raw (always-0-in-discovery-mode) input.
  [`worker/index.ts:783`](../../src/worker/index.ts#L783)

**Mismatched DI-override guard (asymmetric by design, not "both or neither")**

- `createVitestOverride` alone is always wrong (setup-baseline always runs and needs `startVitest`).
  [`worker/index.ts:753`](../../src/worker/index.ts#L753)

- `startVitestOverride` alone is only wrong when discovery will actually run (`files=[]`).
  [`worker/index.ts:758`](../../src/worker/index.ts#L758)

**Pre-existing bug found via this fix's own tests**

- The real (non-heartbeat) completion signal was unguarded -- a torn-down IPC channel here used to cascade into an unhandled rejection.
  [`worker/index.ts:835`](../../src/worker/index.ts#L835)

**Tests**

- Per-file heartbeat, discriminated by which file is being measured -- not by an unenforced call-order assumption.
  [`worker-coverage-heartbeat.test.ts:56`](../../test/worker-coverage-heartbeat.test.ts#L56)

- Discovery heartbeat + the baseline-total regression check in the same test.
  [`worker-coverage-heartbeat.test.ts:96`](../../test/worker-coverage-heartbeat.test.ts#L96)

- Heartbeat send() failure is swallowed.
  [`worker-coverage-heartbeat.test.ts:131`](../../test/worker-coverage-heartbeat.test.ts#L131)

- Cap still fires on a genuinely wedged call.
  [`worker-coverage-heartbeat.test.ts:164`](../../test/worker-coverage-heartbeat.test.ts#L164)

- Cap rises with a raised `TEST_MCP_MEASURE_BUDGET_MS`.
  [`worker-coverage-heartbeat.test.ts:196`](../../test/worker-coverage-heartbeat.test.ts#L196)

- Both guard directions, plus the legitimate single-override case that must NOT throw.
  [`worker-coverage-heartbeat.test.ts:232`](../../test/worker-coverage-heartbeat.test.ts#L232)
- Verified against `_bmad-output/planning-artifacts/epics.md` (FR25, Epic 8): the coverage-measurement-phase heartbeat was already-planned, already-attempted scope (the pre-existing, unguarded, completion-only heartbeat this spec fixes traces to Story 8.2/AD-20) -- this is a bugfix to a real defect in already-"done" epic scope, not new epic-sized feature work, so `bmad-quick-dev`'s bugfix route applies; not a story-cycle bypass.
