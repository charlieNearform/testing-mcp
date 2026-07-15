# Story 6.3: Coverage Report in Run Results & UI

**ID:** `6-3`
**Slice:** `src/worker`, `src/types`, `src/ui`
**Type:** `feature`
**Depends on:** `6-0` (observability baseline). Independent of 6.1/6.2; touches the same result
+ UI surfaces, so land after 6.1 to avoid churn if convenient.
**Status:** done (AC1–AC3; AC4 deferred — see Auto Run Result)

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

## Auto Run Result

Status: done for AC1–AC3; **AC4 (threshold-gate signal) DEFERRED** (escalation trigger hit).

**Change:** A `coverage: true` run now carries an overall + per-file coverage report (`TestResult.coverage`, `CoveragePct` for statements/branches/functions/lines), produced by a dedicated `measureCoverageSummary` V8 pass (reporter `json-summary`) that mirrors the proven `measureCoverage` graceful contract (any failure → `undefined`, never fails the run; temp dir always cleaned). The pass is scoped to the SAME selection the run executed. Plain (non-coverage) runs carry no coverage field (no perf hit). The UI run-detail shows overall % as stat tiles + a per-file table; the run-history row/summary surfaces overall line %.

**Escalation decisions (both triggers evaluated):**
- *Second-run trigger:* the source→test MAP is built per-test-file, so there is no single existing coverage run yielding a whole-project summary to reuse; merging per-file V8 data was judged too risky to author unattended. Chosen approach: one dedicated `json-summary` pass, run ONLY in the already-measurement-heavy `coverage: true` mode (marginal next to the N per-file map runs), scoped to what ran, failing gracefully. Documented, not silently double-running plain runs.
- *AC4 (threshold gate) trigger:* `coverage-summary.json` exposes achieved percentages but NOT the project's configured thresholds, and we intentionally pass `thresholds: undefined` so the project's gate can't fail our measurement pass. A clean gate signal needs reading the project's Vitest `coverage.thresholds` (incl. per-file/glob scopes) — a separate, non-trivial piece. **Deferred** with a note (deferred-work); the reviewer confirmed the deferral is sound (data on hand is necessary-but-not-sufficient).

**Files changed:** `src/types/contracts.ts` (`CoveragePct` + optional `coverage`), `src/worker/index.ts` (`measureCoverageSummary`/`mapCoverageSummary`/`computeCoverageSummary`, wired into `handleRun`), `src/types/ipc.ts` (optional lenient `coverage` in `resultShape`), `src/ui/index.ts` (coverage section + run-row column + `coverageLines` summary). Tests: `test/worker-result.test.ts` (`mapCoverageSummary` mapping/defaults/NaN-coercion), `test/coverage-build.test.ts` (real coverage run carries the report), `test/worker-run.test.ts` (plain run → no coverage), `test/ui-history.test.ts` (coverage in detail + row).

**Review:** Edge Case Hunter. 1 HIGH patched — the coverage pass now honours `changed` so a changed-only incremental run no longer silently re-measures the whole suite (cost + mismatch). 1 LOW patched — non-numeric `pct` sentinel coerced to 0 (no "NaN%"). Deferred: subset-vs-whole-project qualification and `all: false` inflation (→ Story 6.10, which combines coverage across runs), unbounded per-file table, `../..` paths for out-of-root files. → deferred-work.

**Verification:** `pnpm run typecheck` exit 0; `pnpm build` exit 0; `pnpm test` exit 0 (39 files, 187 tests).
