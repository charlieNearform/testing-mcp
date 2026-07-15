# Epic 6 Context: Post-v1 Enhancements — Onboarding, Hardening & Observability

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epic 6 is the Phase-2 batch of enhancements shipped after the v1 epics (1–5) closed. It has three
threads: smoother agent/human onboarding (already shipped), a hardening pass, and — the bulk of the
remaining work — refining the incremental test-selection model and making runs observable. The
selection thread reshapes the original "always full suite when uncertain" behaviour into "select
tight and report confidence": incremental runs should stay tight and useful across long uncommitted
sessions, ignore changes that cannot affect tests, bound brand-new files by the static graph, and
signal (not silently skip) when a full pass is warranted. The observability thread surfaces the full
per-test picture, coverage, run history (in-memory now, on-disk later), and the real selection
reason/confidence in the monitoring UI.

## Stories

- Story 6.0: Post-v1 onboarding & hardening (as-built retrospective, done)
- Story 6.1: Per-passing-test detail + persistent project status banner
- Story 6.2: On-disk run-history persistence
- Story 6.3: Coverage report in run results & UI
- Story 6.4: Surface the real selection reason in run results
- Story 6.5: Don't full-suite on test-irrelevant file changes
- Story 6.6: New source files bounded by the git static graph
- Story 6.7: "Changed since last run" incremental baseline
- Story 6.8: Selection confidence signal
- Story 6.9: Optional CRG-backed impact analysis (backlog / spike)
- Story 6.10: Combined incremental coverage

## Requirements & Constraints

The ratified (2026-07-15) selection philosophy is **"select tight + report confidence"**, softening
the old invariant 5. Apply it consistently across the selection stories:

- **Run the full suite only for genuinely unbounded changes:** build/test config (`package.json`,
  lockfiles, `*.config.*`, `tsconfig*.json`, setup files like `vitest.setup.*`), setup-baseline
  modules, an implicated unmeasurable test, or when git/static-graph is unavailable.
- **Bounded-but-uncertain → run the tight set and mark degraded confidence** with reasons (e.g. a
  modified source file unknown to the coverage map, a deleted file whose impact can't be bounded,
  no snapshot/base yet). Never silently skip without signalling — degraded confidence is the safety
  net that tells the caller to run a full pass before relying on the result.
- **Default incremental baseline = "since last run"** using a per-project content-hash snapshot, not
  git HEAD. This keeps a long uncommitted edit→run→edit session from growing the delta back toward a
  full suite. git-HEAD (`since: "head"`) remains available as an opt-out (e.g. for CI). With no valid
  snapshot yet, fall back safely (full or git-HEAD delta) to establish the baseline — never
  under-select.
- **Filter test-irrelevant paths first:** non-code files (docs/markdown, VCS/editor/agent dotfiles)
  plus any patterns in an optional project `.test-mcp-ignore` (gitignore-style). Ignored files never
  drive selection; a mix of ignored + relevant changes selects only on the relevant ones.
- **New/untracked source unknown to the map → bound by the git `--changed` static graph** (the new
  test plus existing tests statically importing the new source), not the full suite.
- **Snapshot advances only for validated files** after a run (partial-run safety); handle deletions
  in the changed set (tests importing a deleted file re-run).
- **Combined incremental coverage:** merge per-test-file coverage across runs into a whole-project
  picture — a full run sets the baseline, incremental runs refresh the test files that ran, combined
  coverage = union of each test file's latest measurement. A changed source invalidates its entry
  until re-measured; a changed-but-unmeasured file marks the combined report degraded confidence, so
  a threshold verdict (e.g. "100% met") is only asserted at high confidence.
- **All new behaviours ship as defaults with documented opt-out flags** (ignore-filter, since-last-run,
  confidence); exact flag names finalised in the relevant stories.

Observability requirements: the per-test list must cover all executed tests (pass/fail/skip), stay
bounded/summarized for large suites, and be viewable in run-detail. Coverage summaries are additive
and omitted when a run had no coverage; the project's own Vitest thresholds are reported (test-mcp
does not invent its own), and a threshold failure is surfaced distinctly from ordinary test failures.
The selection reason must state the real cause of a decision (not a generic "full suite").

## Technical Decisions

- Every persisted JSON carries `schemaVersion`; migrate or report a clear non-crashing error on old
  versions. Error envelope is `{ code, message, details? }`; the daemon never crashes — tool/worker
  failures return structured errors and stay healthy for other projects.
- Validate all external input (tool params, file contents, IPC messages) with Zod at the boundary.
- Tests run under the project's OWN Vitest in a per-project forked worker (cwd = project root); the
  daemon never imports a project's Vitest.
- New persisted per-project artifacts live in `<git-root>/.test-mcp/` (git-ignored):
  `last-run-snapshot.json` (`{ schemaVersion, takenAt, files: { <relpath>: <sha256> } }`), the
  optional `.test-mcp-ignore`, per-run history records under `history/` (6.2), and per-test-file
  coverage data extending the existing source→test reverse coverage map (6.10).
- `TestResult` gains optional additive fields: `tests[]` (per-test name/file/status), `coverage`
  (overall + per-file summary), and `confidence` (`{ level: "high" | "degraded"; reasons: string[] }`).
  These are additive — the placeholder `TestResultSchema` is an intentional stub; do not fill it.
- `run_tests` gains `since?: "last-run" | "head"` (default `"last-run"`) plus opt-out flags for the
  new defaults. `getChangedFiles` must distinguish added/modified/deleted and support a snapshot
  baseline.
- Run history is owned by the orchestrator — in-memory buffer now, on-disk persistence added in 6.2
  (rehydrated most-recent-first, capped, oldest pruned).

## Cross-Story Dependencies

Implementation order: **6.0 (done) → 6.4 → 6.5 → 6.6 → 6.7 → 6.8 → 6.1 → 6.2 → 6.3 → 6.10**; 6.9 is
backlog/spike.

- 6.4 (real selection reason) is the observability foundation the later selection stories report into.
- 6.5 → 6.6 → 6.7 build the selection refinements in sequence (ignore filter, static-graph bounding
  for new files, then the since-last-run snapshot baseline).
- 6.8 (confidence signal) consumes the selection outcomes of 6.5/6.6/6.7 (degraded when
  modified-unmapped, unmeasurable test implicated, deleted-file impact unbounded, or snapshot/base
  missing).
- 6.2 (on-disk history) depends on 6.1's richer run records.
- 6.10 (combined incremental coverage) depends on 6.3 (coverage report), 6.7 (snapshot/change model),
  and 6.8 (confidence).
- 6.9 (optional CRG impact) is spike-first, never a hard dependency; when present it augments (not
  replaces) selection, and its contribution feeds 6.4's reason and 6.8's confidence.
