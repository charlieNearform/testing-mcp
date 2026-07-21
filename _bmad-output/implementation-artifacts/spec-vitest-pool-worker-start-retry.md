---
title: 'Retry a transient vitest-pool worker-start failure before failing the run'
type: 'bugfix'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 2
context: []
baseline_commit: '8e4944e5e8fa9671b520e0b644668367c4c87e05'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A real project hit `[vitest-pool]: Failed to start ${worker} worker for test files ...` — a documented, transient Vitest 4 `forks`-pool bug (its own **90-second** internal `WORKER_START_TIMEOUT` firing; multiple upstream GitHub issues describe it passing on re-run, worse under resource pressure). Today this propagates unhandled straight to a `WorkerFailure` for the MCP caller, with zero retry, for what is very likely a one-off infra hiccup. Iteration 1 of this spec built a retry that only heartbeated *between* retry attempts — discovered via adversarial review to be structurally unreachable in the common case: the orchestrator's stall watchdog fires at `testTimeoutMs + staleTestGraceMs` (~10s by default), far sooner than Vitest's own 90s internal wait before the target error even surfaces, so the worker gets killed before the retry code ever runs.

**Approach:** Retry the failing `startVitest()` call a small, fixed number of times, ONLY when the caught error's message matches this specific class (never retry a genuine test failure or unrelated error). Critically: send a periodic heartbeat **while each attempt is still pending** (not just between retries), capped at a ceiling comfortably covering Vitest's own known 90s timeout, so the orchestrator's stall watchdog doesn't kill the worker mid-wait. The heartbeat reuses the existing `config` message type (not `progress`) so it resets the watchdog without clobbering displayed test-progress counts a concurrent `runOnce` call may have already reported.

</frozen-after-approval>

## Boundaries & Constraints

**Always:**
- Detect the failure by message content only (e.g. matches `/\[vitest-pool\]:\s*Failed to start[\s\S]+worker for test files/` — `[\s\S]` not `.` so an embedded newline in the message still matches).
- After exhausting retries, re-throw the **original** error unchanged.
- While a `startVitest()` attempt is pending, send a `config` heartbeat on a fixed short interval, stopping once the attempt settles (success or any error) OR once elapsed time passes the heartbeat ceiling for THAT attempt — whichever first. Send `testTimeoutMs` when known; omit it when not (see iteration-2 revision below) — either way the message is sent, since `armWatchdog` on the receiving end already treats a present-but-unchanged or absent `testTimeoutMs` as "just reset the timer, don't touch the effective value."
- Reset the reporter's `total`/`completed`/`modules`/`unhandled` state fresh for each retry attempt — a discarded attempt's partial progress must never leak into a retried attempt's numbers.
- Measure `wallClockMs` from the final, successful attempt only — retry/backoff time must not inflate the reported run duration. (This is deliberately a DIFFERENT number from the orchestrator's own independently-tracked run duration, which does span retries — the two answer different questions: "how long did Vitest itself take" vs. "how long did this whole run take.")
- Wrap the heartbeat's `send()` call in try/catch, matching the existing pattern on every other reporter-hook `send()` in this file — a torn-down IPC channel must never crash the worker.
- Scale the retry delay per attempt (e.g. `POOL_START_RETRY_DELAY_MS * attempt`) rather than a single fixed delay, giving a failure attributed to "resource pressure" a little more room to actually clear.
- `clearInterval` the heartbeat timer once its ceiling is passed, rather than continuing to no-op-tick until the attempt itself settles.
- Log each retry attempt to stderr for operator visibility.

**Ask First:** none remaining.

**Never:**
- Never widen this to a generic "retry any worker error" mechanism.
- Never touch the orchestrator's stall-watchdog logic itself (`src/orchestrator/index.ts`) — confirmed workable worker-side (+ a minor, additive IPC schema relaxation) only.
- Never add a new dependency or touch `vitest`'s pinned version.
- Never let the heartbeat send a `progress` message (would overwrite displayed completed/total with a false 0/0) — `config` only.
- Never expand scope to the coverage-measurement code path (`buildAndPersistCoverageMap`/`measureCoverage`, which call `startVitest` directly and already silently swallow errors via `withTimeout`'s fallback) — a real, separate exposure to the same upstream bug, logged to `deferred-work.md` instead.

## Spec Change Log

- **Trigger:** iteration-2 adversarial re-review (Blind Hunter) found that when `readResolvedRunConfig()` can't resolve `testTimeoutMs` (best-effort; fails on discovery hiccups or an older Vitest), iteration 2's heartbeat silently no-ops — reproducing iteration 1's exact "killed before the retry/heartbeat can help" failure, just for a narrower trigger condition, contradicting this spec's own general claim that the heartbeat prevents the watchdog from killing the worker mid-wait.
- **Amended:** `FromWorkerSchema`'s `config` variant (`src/types/ipc.ts`) relaxes `testTimeoutMs` from required to optional — matching what the orchestrator's `armWatchdog(testTimeoutMs?: number)` already does internally (resets the watchdog's `hasHeardFromWorker` flag and reschedules unconditionally; only skips updating the *effective* timeout value when the argument is absent). This lets the heartbeat send `config` truthfully even when no real `testTimeoutMs` is known, closing the gap completely instead of accepting it. No other orchestrator code changes — `armWatchdog` already supports this.
- **Avoids:** shipping a fix that still has a real, if narrower, path back to iteration 1's exact bug.
- **KEEP:** everything else from iteration 1 → 2 (heartbeat-while-pending via `config`, not `progress`; message-only classification; re-throw original error on exhaustion; per-attempt `wallClockMs`) is confirmed sound and must survive re-derivation.

## Code Map

- `src/types/ipc.ts` — `FromWorkerSchema`'s `config` variant and the `FromWorker` TS union: `testTimeoutMs` required → optional.
- `src/worker/index.ts` — `handleRun()`: thread the already-resolved `testTimeoutMs` (possibly `undefined`) down into `runVitest()`.
- `src/worker/index.ts` — `runVitest()`: accept `testTimeoutMs` and an optional test-only `startVitestOverride`; pass both to each of the 7 internal `runOnce()` call sites.
- `src/worker/index.ts` — `runOnce()`: fresh reporter state per attempt; heartbeat-while-pending helper (now unconditional, `testTimeoutMs` included only when defined; try/catch around its `send()`; `clearInterval` past the ceiling); bounded, per-attempt-scaled-backoff retry loop; per-attempt `wallClockMs`.
- `test-fixtures/pool-retry-project/` — reused (one passing test).
- `test/worker-pool-retry.test.ts` — revise: eventual success, retries-exhausted (original error), no-retry-on-unrelated-error, heartbeat is `config` (with `testTimeoutMs` when known, without it when not) and truly stops after settling (assert no further messages after completion, not just a lower bound), reporter state doesn't leak across a retried attempt.
- `test/orchestrator-stall-watchdog.test.ts` — add one test proving the actual cross-component assumption this whole fix relies on: repeated `send-config` heartbeats (the existing blocking-worker fixture already supports this trigger) keep the real `Orchestrator`'s watchdog from firing past what would otherwise be the stall deadline. This is the exact class of assumption that broke iteration 1 and remained unverified through iteration 2's initial review.

## Tasks & Acceptance

**Execution:**
- [x] `src/types/ipc.ts` -- relax `config`'s `testTimeoutMs` to optional (schema + TS type)
- [x] `src/worker/index.ts` -- thread `testTimeoutMs` from `handleRun` through `runVitest` into `runOnce` (all 7 call sites)
- [x] `src/worker/index.ts` -- heartbeat helper: unconditional (sends `config` with or without `testTimeoutMs`), try/catch around `send()`, `clearInterval` past ceiling
- [x] `src/worker/index.ts` -- retry loop: fresh reporter state per attempt, per-attempt-scaled backoff, per-attempt `wallClockMs`
- [x] `test/worker-pool-retry.test.ts` -- revised per Code Map above (6 tests)
- [x] `test/orchestrator-stall-watchdog.test.ts` -- added the cross-component heartbeat-survives-the-watchdog test
- [x] `deferred-work.md` -- logged the coverage-measurement-path gap (out of scope here)
- [x] `test/ipc-validation.test.ts` -- updated: an existing test asserted the OLD (now intentionally relaxed) contract that `config` without `testTimeoutMs` must be rejected; flipped to assert it's accepted, plus two new tests for the fields that must still be required (`runId`, and `testTimeoutMs`'s type when present)
- [x] `src/worker/index.ts` -- third review pass (patch, no further loopback needed): `withPoolStartHeartbeat` now fires one heartbeat immediately on entering an attempt, not only on the first interval tick -- when `testTimeoutMs` is unknown, the orchestrator's watchdog is still in its short provisional phase (`staleTestGraceMs` alone, default 5000ms), and waiting for the first 4s tick could burn most of that margin under the same resource pressure that triggers the underlying bug

**Acceptance Criteria:**
- Given `startVitest()` throws the classified message fewer times than the retry budget, when `runOnce` runs, then it eventually returns the successful result, `wallClockMs` reflects only the successful attempt, and the result's `total`/`completed` reflect ONLY that attempt (no carryover from a discarded one).
- Given `startVitest()` throws that message on every attempt through the budget, when `runOnce` runs, then it rejects with the original, unmodified error.
- Given any OTHER thrown message, when `runOnce` runs, then it rejects immediately with no retry.
- Given an attempt is pending for longer than one heartbeat interval, when time elapses, then a `config` message is sent (with `testTimeoutMs` when known, without it when not) on that project's `runId` — and no further `config` message arrives once the attempt has actually settled.
- Given the real `Orchestrator` and its stall watchdog (not just the worker's own code in isolation), when repeated `config` heartbeats arrive during what would otherwise be a stall-worthy silence, then the watchdog does not fire.

## Suggested Review Order

**The retry + heartbeat mechanism**

- Entry point: the retry loop itself — fresh reporter per attempt, heartbeat-wrapped `startVitest()`, message-classified retry, per-attempt-scaled backoff, per-attempt `wallClockMs`.
  [`worker/index.ts:216`](../../src/worker/index.ts#L216)

- The heartbeat helper — fires immediately on entry (closes a timing-margin gap found in review), then on a fixed interval, capped per-attempt, `send()` guarded by try/catch.
  [`worker/index.ts:125`](../../src/worker/index.ts#L125)

- The failure classifier — message-content-only, deliberately narrow so this never widens to "retry any error".
  [`worker/index.ts:108`](../../src/worker/index.ts#L108)

- Reporter state rebuilt fresh per attempt — closes the "discarded attempt's progress leaks into a retry" bug found in review.
  [`worker/index.ts:168`](../../src/worker/index.ts#L168)

**The schema relaxation this fix actually depends on**

- `testTimeoutMs` optional on `config` — lets the heartbeat fire truthfully even when discovery never resolved a real value; the orchestrator's `armWatchdog` already handled this internally.
  [`types/ipc.ts:28`](../../src/types/ipc.ts#L28)

**Threading `testTimeoutMs` down to where the heartbeat needs it**

- `runVitest()`'s new `testTimeoutMs`/`startVitestOverride` parameters.
  [`worker/index.ts:445`](../../src/worker/index.ts#L445)

- Where the real `startVitest` is resolved, unless a test override is supplied.
  [`worker/index.ts:460`](../../src/worker/index.ts#L460)

- `handleRun()` passing the already-discovered `testTimeoutMs` through.
  [`worker/index.ts:782`](../../src/worker/index.ts#L782)

**Proof this survives the real orchestrator (the exact assumption that broke iteration 1)**

- Repeated `config` heartbeats keep the REAL `Orchestrator`'s stall watchdog from firing — not just the worker's own code in isolation.
  [`orchestrator-stall-watchdog.test.ts:105`](../../test/orchestrator-stall-watchdog.test.ts#L105)

**Peripherals**

- Schema contract test flipped from reject to accept, matching the intentional relaxation.
  [`ipc-validation.test.ts:80`](../../test/ipc-validation.test.ts#L80)

- Worker-level retry/heartbeat tests (6 cases) and the minimal fixture they run against.
  [`worker-pool-retry.test.ts`](../../test/worker-pool-retry.test.ts)

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run build` -- expected: exit 0
- `pnpm test` -- expected: full suite passes; this repo's suite has pre-existing, already-documented load-sensitive flakiness independent of this change (see `deferred-work.md`) — re-run in isolation if a failure looks unrelated before treating it as a regression
