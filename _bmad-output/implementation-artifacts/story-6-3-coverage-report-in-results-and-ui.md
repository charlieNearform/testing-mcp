# Story 6.3: Coverage Report in Run Results & UI

**ID:** `6-3`
**Slice:** `src/worker`, `src/types`, `src/ui`
**Type:** `feature`
**Depends on:** `6-0` (observability baseline). Independent of 6.1/6.2; touches the same result
+ UI surfaces, so land after 6.1 to avoid churn if convenient.
**Status:** ready-for-dev

## Source

The daemon runs V8 coverage while building the source→test map, but never surfaces a coverage
**report** (percentages) to the agent or the UI. We want a run to report its coverage summary
(overall + per-file) so a human can see it in the UI, and so a project that enforces a coverage
threshold (e.g. sanity-check at 100%) has its pass/fail visible.

- Related: `src/coverage/index.ts` (already runs V8 coverage), `src/worker/index.ts`
  (`measureCoverage` uses the `["json"]` reporter).
- Verification target: `~/code/sanity-check` will set `coverage.thresholds` to 100% in its
  `vitest.config.js` so a regression drops below 100% and the report shows it.

## Acceptance criteria

1. **Given** a run is executed with `coverage: true`
   **When** the worker reports the result
   **Then** the result carries a coverage summary: overall percentages (statements, branches,
   functions, lines) and per-file percentages, in an additive optional field
   (e.g. `coverage?: { total: {...}, files: [{ file, statements, branches, functions, lines }] }`).

2. **Given** a run executed **without** coverage
   **When** the result is reported
   **Then** the coverage field is absent (coverage is only computed when requested — no perf hit
   on plain runs).

3. **Given** a completed run in history
   **When** its detail is viewed in the UI (`/ui/api/projects/:id/runs/:runId`)
   **Then** a coverage report is shown (overall % prominently, per-file breakdown), and the
   project card / run row surfaces the overall % at a glance.

4. **Given** the project's own Vitest config enforces coverage thresholds (e.g. 100%)
   **When** coverage falls below threshold
   **Then** the run surfaces that the coverage gate failed (a distinct signal — e.g.
   `coverage.thresholdsMet: false` and/or reflected in `success`), so enforcement is visible in
   the result and UI. (Thresholds live in the project's Vitest config; test-mcp reports them,
   it does not invent its own.)

## Out of scope

- Changing how the source→test coverage **map** is built (that stays as-is).
- Historical coverage trends / sparklines over time (future).
- test-mcp defining or enforcing its own thresholds independent of the project's Vitest config.
- Line-level annotated coverage (just summary percentages, overall + per-file).

## Notes for the agent

- **Worker (`src/worker/index.ts`)** — `measureCoverage` runs Vitest with `coverage.reporter:
  ["json"]` (→ `coverage-final.json`). Add `"json-summary"` to also emit
  `coverage-summary.json` (has `total` + per-file pct), which is the cheapest source of the
  summary — read and map it into the result. Design so a coverage run produces the summary
  **without a second full run**; reconcile with the existing `buildAndPersistCoverageMap` path
  so you don't double-execute the suite.
- **Contracts (`src/types/contracts.ts`)** — add optional `coverage` to `TestResult` (hand-
  written interface; leave the placeholder `TestResultSchema` alone). IPC `resultShape` uses
  `.passthrough()` so it crosses the boundary; optionally add `coverage` there.
- **Orchestrator** — no change: `RunRecord.result` carries it into history automatically.
- **UI (`src/ui/index.ts`)** — `renderRun`: add a coverage section (overall % as stat tiles,
  per-file as a small table). Optionally add overall % to the run row / project card. Keep the
  inline string-concat style.
- **Threshold signal (AC4)** — Vitest fails the run when thresholds aren't met; capture that
  distinctly from ordinary test failures so the UI can show "coverage gate failed" vs "tests
  failed". Confirm how the worker currently surfaces a threshold failure before wiring it.
- Tests hermetic (sample fixture / temp project): result includes coverage when requested and
  omits it otherwise; UI detail shows the report; a below-threshold project reports the gate.

## Escalation triggers

- If producing the coverage summary cleanly requires a second suite execution (perf regression)
  rather than reusing the existing coverage run, escalate the approach before implementing.
- If Vitest threshold failures aren't cleanly distinguishable from test failures in the worker's
  current result-building, escalate rather than conflating them.
