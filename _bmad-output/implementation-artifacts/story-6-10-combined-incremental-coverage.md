# Story 6.10: Combined Incremental Coverage

**ID:** `6-10`
**Slice:** `src/coverage`, `src/worker`, `src/types`, `src/ui`
**Type:** `feature`
**Depends on:** `6-3` (coverage report), `6-7` (snapshot/change model), `6-8` (confidence)
**Status:** ready-for-dev

## Source

Requested during the 2026-07-15 course-correction. An incremental run only exercises a subset
of tests, so its coverage alone can't describe the whole project. We want a **combined**
coverage picture — a baseline full run plus incremental refreshes — so an incremental run can
report/enforce whole-project coverage without re-running everything, honestly (stale parts
flagged).

- Related: `src/coverage/index.ts` (map + V8 coverage), `src/worker/index.ts` (`measureCoverage`),
  `docs/architecture.md` §Data Model (per-test-file coverage data), Story 6.3/6.7/6.8.

## Acceptance criteria

1. **Given** a full coverage run has established a baseline
   **When** an incremental coverage run executes
   **Then** the coverage map's **per-test-file coverage data** is refreshed for the test files
   that ran, and combined project coverage = the union of every test file's *latest* measurement.

2. **Given** a run executed **without** coverage
   **When** it completes
   **Then** no coverage data is written and the last combined picture is untouched.

3. **Given** a source file changed
   **When** coverage is combined
   **Then** its stale coverage is invalidated (line numbers shift) until re-measured; a
   changed-but-unmeasured source marks the combined report **degraded confidence** (6.8).

4. **Given** a coverage threshold is enforced (e.g. sanity-check at 100%)
   **When** the combined report is produced from an incremental run
   **Then** the threshold verdict is reported **together with confidence**, so "100% met" is only
   asserted at `high` confidence (a degraded combined report says "run a full pass to confirm").

5. **Given** the UI run-detail / coverage view
   **When** a combined report is shown
   **Then** overall + per-file coverage is displayed with its confidence, distinguishing
   freshly-measured files from baseline-carried ones.

## Out of scope

- Line-level annotated coverage (summary percentages only, overall + per-file).
- Historical coverage trends over time.
- test-mcp inventing its own thresholds (report the project's Vitest thresholds — Story 6.3).

## Notes for the agent

- **Storage**: extend the coverage map to persist **per-test-file coverage data** (not just the
  reverse mapping). Bump `COVERAGE_MAP_SCHEMA_VERSION` (3 → 4) with a migration/skip-on-mismatch,
  per the `schemaVersion` invariant.
- **Merge**: combined = union of each test file's latest coverage. Prefer a well-tested merge
  (e.g. `istanbul-lib-coverage` `CoverageMap.merge`, or c8's) over hand-rolled counting — but do
  **not** add a runtime dependency the daemon ships without authorization; if a new dep is needed,
  STOP and hand back to the orchestrator.
- **Invalidation** keys on source content (reuse the 6.7 snapshot hashes): a file whose source
  changed since its coverage was measured is stale → excluded/flagged until re-measured.
- **Confidence**: reuse 6.8 — the combined report's confidence is `degraded` when any changed
  source is unmeasured in the current combined set.
- **Perf**: only the selected test files are re-measured per run (that's the point); the baseline
  supplies the rest. A full coverage run rebuilds the baseline.
- Tests hermetic (sample fixture): baseline full → combined 100%; edit one source + incremental →
  combined refreshes that file, others carried, confidence high when the changed file was
  re-measured, degraded when it wasn't.

## Escalation triggers

- If accurate combining genuinely requires a **new runtime dependency** (coverage-merge lib) not
  already in `package.json`, STOP and hand back — dependencies are orchestrator-authorized only.
- If per-test-file V8 data proves too large to persist, escalate the storage approach (e.g.
  store per-file summary percentages rather than full hit maps) before implementing.
