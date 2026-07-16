# Story 6.8: Selection Confidence Signal

**ID:** `6-8`
**Slice:** `src/selection`, `src/types`, `src/orchestrator`, `src/ui`
**Type:** `feature`
**Depends on:** `6-5`, `6-6`, `6-7` (they produce the inputs the confidence verdict summarizes)
**Status:** done

## Source

Ratified in `sprint-change-proposal-2026-07-15.md`. Invariant 5 was softened from "when
uncertain → full suite" to "select tight + **report confidence**": run the bounded set and tell
the caller when it may not fully cover the changes, so the AI runs a full pass at
feature-completion. Full-suite is still forced only for genuinely unbounded changes.

- Related: `docs/architecture.md` (invariant 5, selection algorithm step 5, `TestResult.confidence`),
  `src/selection/index.ts`, `src/orchestrator/index.ts`, `src/types/contracts.ts`, `src/ui/index.ts`.

## Acceptance criteria

1. **Given** a bounded, provably-complete incremental selection (e.g. only test files changed, or
   all changed sources are mapped and re-measured)
   **When** the result is returned
   **Then** it carries `confidence: { level: "high", reasons: [] }`.

2. **Given** a bounded-but-uncertain selection — a **modified** source unknown to the map, an
   unmeasurable test implicated, a **deleted** file whose impact can't be bounded, or no
   snapshot/base available
   **When** the result is returned
   **Then** it carries `confidence: { level: "degraded", reasons: [...] }` naming each cause, so
   the caller can choose to run a full pass — never a silent skip.

3. **Given** a genuinely unbounded change (build/test config, setup-baseline module, no git)
   **When** selection runs
   **Then** the full suite runs (as before) and confidence is `high` (a full run *is* complete).

4. **Given** the monitoring UI run-detail view
   **When** a run with degraded confidence is viewed
   **Then** the confidence level and reasons are shown (distinct from failures).

5. **Given** existing consumers
   **When** `confidence` is added
   **Then** it is optional/additive; runs still succeed; an opt-out flag can disable confidence
   gating if a caller wants the old always-full behaviour.

## Out of scope

- **Auto-running** the full suite on degraded confidence — the agent decides (the signal informs).
- The selection *behaviour* changes themselves (those are 6.5/6.6/6.7); this story only computes
  and surfaces the verdict from their outputs.
- Combined-coverage confidence (that's 6.10, which reuses this signal).

## Notes for the agent

- `SelectionEngine.plan` already knows the uncertain cases (unknown-to-map, alwaysRun/unmeasurable,
  etc.). Have it emit a `confidence` verdict alongside the plan; the orchestrator attaches it to
  the `TestResult` (works with 6.4, which already routes the orchestrator's decision into the
  result). Keep `SelectionEngine.plan` pure.
- Add optional `confidence?: { level: "high" | "degraded"; reasons: string[] }` to `TestResult`
  in `src/types/contracts.ts` (leave the placeholder `TestResultSchema` alone; IPC `resultShape`
  passes it through via `.passthrough()`).
- Reasons are short human strings ("modified source not in coverage map: src/x.ts";
  "unmeasurable test implicated: test/heavy.test.tsx"; "no last-run snapshot — first run").
- UI (`src/ui/index.ts`) `renderRun`: show a confidence badge + reasons; keep inline
  string-concat style.
- Tests hermetic: high on a fully-mapped incremental; degraded (with the right reasons) on a
  modified-unmapped source; high on a full run.

## Escalation triggers

- None major — this rides on the ratified invariant-5 change. If a case is ambiguous between
  "unbounded → full" and "bounded → degraded", default to the safer classification (full/high)
  and note it.

## Post-hoc correction (2026-07-16)

AC1 ("all changed sources mapped and re-measured → provably complete, `high` confidence") was
reported correctly but never actually reached in practice: the selection engine unconditionally
unioned in Vitest's HEAD-scoped `--changed` pass regardless of confidence, so a fully-mapped
change was still widened to everything uncommitted since HEAD. Fixed alongside Story 6.7's
correction (see `story-6-7-changed-since-last-run-baseline.md`) — see that story's post-hoc
correction note for the root cause and fix.
