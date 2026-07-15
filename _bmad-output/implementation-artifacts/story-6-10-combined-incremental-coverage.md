# Story 6.10: Combined Incremental Coverage

**ID:** `6-10`
**Slice:** `src/coverage`, `src/worker`, `src/types`, `src/ui`
**Type:** `feature`
**Depends on:** `6-3` (coverage report), `6-7` (snapshot/change model), `6-8` (confidence)
**Status:** done (unblocked 2026-07-15 — user authorized the `istanbul-lib-coverage` dependency)

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

## Auto Run Result

Status: **DONE (dev-auto 2026-07-15).** Initially escalated as blocked (below); the user then
authorized the `istanbul-lib-coverage` runtime dependency, unblocking the accurate line-hit merge.

**Change:** `coverage: true` runs now report COMBINED whole-project coverage — the union of every
test file's latest measurement — so an incremental run reports whole-project coverage without
re-running everything. Each test file's istanbul-shaped `coverage-final.json` (captured during the
existing per-file map build — **no extra suite run**, which also let me REMOVE Story 6.3's separate
`coverage-summary` pass and its subset/`all:false` inaccuracy) is persisted to a separate
`.test-mcp/coverage-data.json` (schema 1) — kept out of the reverse map so selection's hot read
stays small. `combineCoverage` merges the latest data via `istanbul-lib-coverage` (a real line-hit
union: two tests covering different halves of a file → 100%). Each test records the content hash of
every source it measured; a source whose current hash differs from any contributing test's measured
version is `stale` → the combined report reports `degraded` confidence (Story 6.8), so "100%" is
only asserted at `high`. The UI run-detail shows the combined report, its confidence, and per-file
`fresh`/`stale` tags; the run-history row shows overall line %.

**Design choice vs the story note:** the note suggested bumping `COVERAGE_MAP_SCHEMA_VERSION` (3→4)
to hold per-test data in the reverse map. I kept the reverse map lean (selection reads it on every
run) and stored the heavy per-test istanbul data in a separate `coverage-data.json` instead — same
intent, no schema churn on the hot path, and no discarding of existing v3 maps.

**Files changed:** `src/coverage/combined.ts` (NEW — persist/merge/staleness), `src/coverage/index.ts`
(`FileMeasurement.data?`; export `isTestFile`), `src/worker/index.ts` (capture per-test data, hash
measured sources, `persistAndCombine`, removed the 6.3 pass), `src/types/contracts.ts` (extended
`coverage` with `combined`/`confidence`/per-file `fresh`/`stale`), `src/ui/index.ts` (combined label,
confidence badge, fresh/stale tags). Dependency: `istanbul-lib-coverage@3.2.2` (+ `@types/…`).
Tests: `test/combined-coverage.test.ts` (NEW — union, staleness incl. two-version mismatch, zero-hit,
corrupt-skip, prune-deleted-tests, persistence), `test/coverage-build.test.ts` (combined + staleness
integration), removed the obsolete `mapCoverageSummary` unit tests.

**Review:** Blind Hunter + Edge Case Hunter (parallel). The reviews caught real number/confidence
soundness bugs; patched: (F1) a mismatched-version merge no longer falsely reports `high` — per-test
source hashes make it `stale`/`degraded`; (F2) zero-hit sources are hashed so they aren't spuriously
stale; (F3) deleted/renamed test files are pruned so phantom coverage can't inflate the number;
(F6) a corrupt per-test entry is skipped (loud on stderr), not silently swallowed or allowed to
poison the report; plus reason-cap, Windows drive-path exclusion, `isTestFile` dedup, stale-comment
removal. Deferred (deferred-work): the 6.7-class lost-update if a source is edited mid-coverage-run;
unbounded `coverage-data.json`/history-record growth on churn; 0-statement-file % accuracy; a
measured-nothing run reporting from unchanged carried data.

**Verification:** `pnpm run typecheck` exit 0; `pnpm build` exit 0; `pnpm test` exit 0 (40 files,
196 tests).

---

### Original escalation (2026-07-15, later unblocked)

**Blocking condition:** The core of AC1 — "combined project coverage = the union of every test
file's *latest* measurement" — requires merging per-test-file coverage at the **line-hit level**
(a line covered by ANY test is covered). Percentages cannot be unioned (two tests each covering
"50%" of a file may cover the same or different lines), so the escalation-trigger's fallback of
"store per-file summary percentages rather than full hit maps" cannot produce an accurate combined
number either. Accurate union needs a coverage-merge capability, and this repo has none available:

- Runtime deps are only `@modelcontextprotocol/sdk`, `commander`, `zod`. `@vitest/coverage-v8` is a
  **dev** dependency (the daemon resolves the *project's* vitest, never ships its own), and
  `istanbul-lib-coverage` is **not installed at all** (not even transitively).
- Adding `istanbul-lib-coverage` (or similar) as a runtime dep is **forbidden** here — CLAUDE.md
  ("Do not add/remove dependencies") and this story's own first escalation trigger both say STOP
  and hand back; dependencies are orchestrator-authorized only.
- Hand-rolling the V8-byte-range → line-coverage conversion and union (what `@vitest/coverage-v8`
  does internally via istanbul) is a large, error-prone reimplementation that can't be verified
  against ground truth in an unattended run — it fails "correctness over cleverness".
- Reusing the *project's* transitively-installed istanbul via the project `require` is a fragile,
  version-drifting, effectively-unauthorized runtime dependency for the daemon.

No safe partial delivers value: AC3/AC4/AC5 (staleness, threshold+confidence, UI) all hang off a
combined number that can't be produced yet, and bumping the map schema to persist per-test-file
data would be speculative scaffolding for a merge that isn't authorized (scope discipline).

**Decision needed from the orchestrator (one of):**
1. **Authorize a coverage-merge runtime dependency** (e.g. pin `istanbul-lib-coverage`), then this
   story proceeds: store per-test-file V8/istanbul coverage in the map (schema 3→4), merge latest
   measurements into a combined `CoverageMap`, derive the summary, key staleness on the Story-6.7
   source hashes, and attach Story-6.8 confidence + the project's threshold verdict.
2. **Re-scope 6.10** to a full-run-only whole-project report (no incremental combination) — which
   Story 6.3 already largely delivers for full runs — and drop the "combine across runs" goal.
3. Provide an approved hand-rolled merge design/spec if a dependency is undesirable.

Story 6.3's deferred notes (subset vs whole-project qualification, `all: false` inflation) are the
natural companions to whichever path is chosen.

**Verification:** n/a — no code changed; `pnpm test` remains green at the Story-6.3 baseline (187).
