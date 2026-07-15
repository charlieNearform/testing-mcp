# Story 3.5: Smart Re-run Decision (Union + Fallback)

Status: done

> **Implemented by the orchestrator (not the local model), by explicit decision.** This is the Epic 3
> integration keystone: it consumes every signal built in 3.1–3.4 (git delta, coverage-map edges,
> setup-baseline `fullSuiteTriggers`, unmeasurable `alwaysRun`) to choose the minimum SAFE test set.

## Story

As an AI agent,
I want re-run decisions that combine both selection signals conservatively,
so that I re-run the minimum safe set.

## Acceptance Criteria

1. **Only test files changed → run exactly those.** ✅
2. **Source files changed → dependent tests via the union of coverage-map and git static-graph.** ✅
3. **Changed file unknown to the map → conservatively run the full suite (no missed failure).** ✅

## What shipped

- **`src/selection/index.ts`** — replaces the stub:
  - `SelectionEngine.plan({ changedFiles, map })` — pure, unit-testable. Returns one of:
    - `full` — undeterminable changes (non-git), a changed **full-suite trigger** (setup-baseline module),
      or a changed source **unknown to the map** (AC3).
    - `changed-only` — a source changed but **no map exists yet** → defer to the worker's git `--changed`
      pass (preserves Story 3.1 behaviour so selection still works before a map is built).
    - `incremental` — only-test-changed (`union:false`, AC1), or known-source-changed → mapped tests ∪
      changed tests ∪ `alwaysRun`, with `union:true` so the run ALSO folds in the git static graph (AC2).
  - `getChangedFiles(projectRoot)` — working-tree-vs-HEAD (tracked) + untracked, POSIX-relative; `null`
    when git is unavailable (→ full). git stderr suppressed.
  - `isTestFile(rel)` — shared test-file heuristic.
- **`src/worker/index.ts`** — new **union run mode**: when given an explicit file list AND `changed:true`,
  runs the coverage-map selection and a `--changed` pass, merges modules deduped by `moduleId`, and
  reports `strategy:"incremental"`. Also: an explicit file selection (files without `changed`) now reports
  `strategy:"incremental"` (it is a selection, not a full run).
- **`src/orchestrator/index.ts`** — `planAndExecute` runs the Selection Engine for incremental requests
  (git changed files + loaded map), then dispatches: `full` → full run; `changed-only` → worker
  `--changed`; `incremental` → explicit files with optional union. `emptyResult` short-circuits
  "no changes" so an empty filter never accidentally runs the whole suite.

## Tests

- `test/selection.test.ts` — pure unit coverage of every `plan` branch (AC1/2/3, full-suite trigger,
  no-map deferral, non-git, empty) + `isTestFile`.
- `test/selection-integration.test.ts` — real git project with a built coverage map: known-source change
  selects only the mapped test; unknown-source change → full suite; only-test change → just that test.

## Dev Agent Record

### Agent Model Used
Orchestrator (Opus) — implemented directly per user decision.

### Completion Notes
- `pnpm run typecheck`, `pnpm run build`, `pnpm test` green (22 files / 80 tests).
- Story 3.1's git-selection tests still pass unchanged: with no coverage map, a source change routes to
  `changed-only` (the worker `--changed` path), so pre-map selection behaviour is preserved.

### File List
- src/selection/index.ts (implemented)
- src/worker/index.ts (union run mode; explicit-selection strategy label)
- src/orchestrator/index.ts (planAndExecute + emptyResult)
- test/selection.test.ts (new)
- test/selection-integration.test.ts (new)
