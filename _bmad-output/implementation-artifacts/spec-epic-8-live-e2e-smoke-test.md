---
title: 'Epic 8 live e2e smoke test against a real vitest worker'
type: 'chore'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
context: []
route: 'one-shot'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** This session's Epic 8 code review and manual live smoke test (run by hand against a real, isolated daemon over the real MCP-over-HTTP socket) proved several fixes worked at runtime, but that proof lived only in throwaway scratch scripts — nothing captured it as a repeatable, committed check.

**Approach:** Adapt the scratch smoke scripts into one hermetic Vitest e2e file that drives the real MCP tool surface (via `InMemoryTransport`, not a real HTTP daemon) against the REAL `dist/worker/index.js` and real vitest fixture projects — covering the two behaviors no existing test exercises: `get_test_status`'s runId-disambiguation between overlapping runs, and the stall watchdog against a genuinely hung real vitest config (not the synthetic blocking-worker fixture used elsewhere). Deliberately excludes scenarios already covered deterministically by `test/mcp-run-tests-async.test.ts`'s blocking-worker-based tests.

</frozen-after-approval>

## Suggested Review Order

**Entry point — what's genuinely new**

- Order-independent overlap test: fires two real runs, dynamically determines which is running vs queued, checks AD-21 live shape and the queued one's own eventual result.
  [`test/epic-8-e2e-smoke.test.ts:78`](../../test/epic-8-e2e-smoke.test.ts#L78)

- Real stall-watchdog test: a real vitest config whose async function never resolves, killed by the provisional (`staleTestGraceMs`-alone) watchdog.
  [`test/epic-8-e2e-smoke.test.ts:142`](../../test/epic-8-e2e-smoke.test.ts#L142)

**Fixtures the above depend on**

- The hang itself — an async config function that never resolves, simulating a real config-discovery hang.
  [`test-fixtures/hanging-config-project/vitest.config.ts:12`](../../test-fixtures/hanging-config-project/vitest.config.ts#L12)

- The fixed-delay fixture shared by the overlap test (kept separate from `test-fixtures/sample-project` deliberately — see next concern).
  [`test-fixtures/live-smoke-project/smoke.test.ts:8`](../../test-fixtures/live-smoke-project/smoke.test.ts#L8)

**Trade-off worth understanding before touching this file**

- Real-vitest-fork count was cut from 5 to 3 after an earlier draft reliably destabilized `test/watch.test.ts` under full-suite parallel load; this repo's suite has documented, only partially-mitigated load-sensitivity independent of this file — see the header comment and `deferred-work.md`.
  [`test/epic-8-e2e-smoke.test.ts:12`](../../test/epic-8-e2e-smoke.test.ts#L12)

- The `tests.length <= 1` (not `=== 1`) and single-snapshot-not-poll-to-completion choices are both deliberate races avoided, not oversights.
  [`test/epic-8-e2e-smoke.test.ts:123`](../../test/epic-8-e2e-smoke.test.ts#L123)

**Peripherals**

- New deferred-work entries documenting the runId-supersede edge case this test surfaced, and the watch.test.ts load-sensitivity follow-up.
  [`_bmad-output/implementation-artifacts/deferred-work.md`](deferred-work.md)

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run build` -- expected: exit 0
- `pnpm exec vitest run test/epic-8-e2e-smoke.test.ts` -- expected: 2/2 pass, consistently across repeated runs in isolation (verified 5/5)
- `pnpm test` (full suite) -- expected: 49/49 files pass. Verified clean on 4 of 6 full-suite attempts during this session; the 2 failures matched this repo's pre-existing, already-partially-mitigated `test/watch.test.ts` load-sensitivity (reproduced independently of this file too — see `deferred-work.md`), not a new or deterministic failure caused by this change.
