# Story 6.4: Surface the Real Selection Reason in Run Results

**ID:** `6-4`
**Slice:** `src/orchestrator`, `src/worker`
**Type:** `refactor`
**Depends on:** `6-0`
**Status:** ready-for-dev

## Source

Investigation on 2026-07-15: an incremental run that fell back to the full suite reported
`selection.reason: "full suite"` — the **worker's** generic label — instead of *why* the
orchestrator chose full (e.g. "changed file unknown to coverage map: .gitignore"). The
orchestrator's Selection Engine already computes a precise reason in `resolveSelection`
(`plan.reason`), but it is discarded: the final `TestResult.selection` is built by the worker
from what it ran, so the agent and the UI never see the real decision.

- Related: `src/orchestrator/index.ts` (`resolveSelection` → `sel.reason`/`sel.strategy`),
  `src/worker/index.ts` (`build()` sets `selection.reason` to `"full suite"` /
  `"explicit file selection"`), `src/selection/index.ts` (`SelectionEngine.plan` reasons).

## Acceptance criteria

1. **Given** an incremental run that falls back to the full suite because a changed file is
   unknown to the coverage map
   **When** the result is returned
   **Then** `selection.reason` states the actual cause (e.g. "changed file unknown to coverage
   map: `<file>`"), not the generic "full suite".

2. **Given** an incremental run selected via the coverage map ∪ git graph, or via git
   `--changed`, or short-circuited as "no changes"
   **When** the result is returned
   **Then** `selection.reason` and `selection.strategy` reflect the orchestrator's decision
   (the `resolveSelection`/`SelectionEngine` reasoning), consistently for every path incl. the
   empty-run and committed-plan paths.

3. **Given** run history / the UI run-detail view
   **When** a run is inspected
   **Then** it shows this real reason (no code change needed there if it already reads
   `selection.reason`; just verify).

4. **Given** existing tests
   **When** the reason is corrected
   **Then** `selection.files` and `selection.strategy` still accurately describe what ran, and
   all current tests pass (update any assertion that pinned the old generic reason).

## Out of scope

- Changing *which* tests are selected (that's 6.5) — this story only corrects the reported
  `reason`/`strategy` to match the decision already made.
- New reason taxonomy/enums — keep human-readable strings consistent with `SelectionEngine`.

## Notes for the agent

- The orchestrator is the source of truth for the decision: thread `sel.reason` and
  `sel.strategy` from `resolveSelection` through `enqueue`/`execute` and **override**
  `result.selection.reason`/`.strategy` before `recordRun`/resolve (and in the empty-run and
  `runPlan` paths). Prefer overriding in the orchestrator over changing the worker, so the
  worker stays a dumb executor.
- `selection.files` should remain what actually ran (worker's `filesRun`); only reason/strategy
  come from the orchestrator's decision.
- Keep it additive/behaviour-preserving for the happy path; this is primarily an observability
  correctness fix.

## Escalation triggers

- If any consumer relies on the worker's `"full suite"` string specifically, flag it before
  changing.
