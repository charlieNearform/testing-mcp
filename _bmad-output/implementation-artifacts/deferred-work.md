# Deferred Work Ledger

## Deferred from: story-3-2-coverage-reverse-map-build-persist (2026-07-14)

- **Single-pass V8 snapshot-diff measurement** — Story 3.2 was implemented with per-test-file measurement (one Vitest run per test file), which the spike proved correct. The architecture's single-pass serial snapshot-diff (same accuracy, ~6x cheaper) is a performance optimisation deferred here. [supersedes AC1's "single-pass" wording; approved trade-off]
- **Vendoring `testpick` (MIT) attribution + license retention** — AC2 (NOTICE/THIRD_PARTY_LICENSES + vendored-module header) is N/A while we do not vendor testpick. Revisit if/when the single-pass algorithm is adopted from testpick.
- Surface `coverageDelta` to the MCP `run_tests` response — currently the map is persisted to disk and the summary returned over IPC only; not exposed to the tool caller.
- Prune stale source files that no test covers after a full rebuild across renamed/deleted sources — current build only prunes edges for re-measured test files (incremental) or starts fresh (full).

## Deferred from: code review of story-3-1-git-aware-delta-selection (2026-07-14)

- Add fast unit tests for `mapModulesToResult` selection branches — story specifies E2E-only coverage
- Assert `selection.reason` strings in git-selection tests — not required by AC
- Wire `dryRun`/`suite`/`planId` run_tests params — pre-existing; Story 4.1 scope
- Consolidate `Orchestrator.execute` into options object as more run params arrive — style/refactor out of scope
- Queue-serialization tests with `changed` flag — pre-existing coverage gap

## Deferred from: spec-6-4-surface-real-selection-reason (2026-07-15)

- source_spec: `spec-6-4-surface-real-selection-reason.md`
  summary: **RESOLVED 2026-07-15 (hardening sweep).** The shared-mutable-reference hazard is closed: `recordRun` and `setRunState` now `structuredClone` the result before retaining/persisting it, so history and run-state hold copies independent of each other and of the returned result. A later in-place mutation of one can no longer corrupt the others.

## Deferred from: spec-6-5-ignore-test-irrelevant-changes (2026-07-15)

- source_spec: `spec-6-5-ignore-test-irrelevant-changes.md`
  summary: Default-ignoring non-code files (`*.md`/`*.txt`/`docs/**`) can silence a rerun for a *fixture-driven* test that reads such a file, and an all-filtered changeset is indistinguishable from a clean tree (no signal).
  evidence: The filter runs before `plan()`, so a non-code fixture a test reads at runtime — which coverage never maps — is dropped instead of forcing the "unknown source → full suite" safeguard. Ratified as the intended "ignore non-code" default, but Story 6.8 (confidence signal) should surface when a run's entire changed set was filtered so a fixture-only edit isn't a silent no-op. Users can also keep specific paths out of the default set (future: allow un-ignoring).
- source_spec: `spec-6-5-ignore-test-irrelevant-changes.md`
  summary: The `.test-mcp-ignore` matcher supports only a documented subset of gitignore syntax; several forms are unsupported and fail toward MORE running.
  evidence: `!` negation compiles to a literal, `?`/`[…]` are literal, trailing-slash `dir/` and bare `dir` don't match a directory's contents (need `dir/**`), leading `**/x` and middle `a/**/b` don't collapse zero dirs, and backslash-separated patterns don't match POSIX paths. All fail safe (nothing excluded → more runs), but silently — a fuller matcher or startup validation/warning would help.
- source_spec: `spec-6-5-ignore-test-irrelevant-changes.md`
  summary: **RESOLVED 2026-07-15 (hardening sweep).** keep-always now covers `babel.config.*`, `jest.config.*`, `.mocharc.*`, `.swcrc`, `.env*`, and `vitest.workspace.*`, so a broad user ignore (e.g. `*.json`) can't drop them; `readIgnorePatterns` now warns on a non-ENOENT read error instead of silently swallowing it.

## Deferred from: spec-6-6-new-file-bounded-by-static-graph (2026-07-15)

- source_spec: `spec-6-6-new-file-bounded-by-static-graph.md`
  summary: **[for Story 6.8]** Bounding a NEW source by the git `--changed` static graph can silently under-run when the new file is reached via a dynamic import / side-effect / DI / config, and the worker's UNION branch has no full-suite fallback (unlike the lone-`--changed` branch), which `alwaysRun` can force it into.
  evidence: `--changed` is a static import graph; a never-measured new file has no coverage-map signal, so a dynamic edge from an existing unchanged test is invisible → that test isn't selected and a regression can ship green. This is the ratified invariant-5 relaxation whose designed mitigation is **6.8's confidence signal** — 6.8 MUST mark bounded-new-file runs as `degraded` confidence (so the agent runs a full pass), and the worker's union branch should gain the same full-suite fallback the `files.length===0` `--changed` branch has. Land these in 6.8.
  evidence-tests: no test yet for (a) a new source reached only by an existing test's dynamic import, (b) the `alwaysRun`-present case removing the worker fallback, (c) a staged-new file (the getChangedFiles staged-add patch is covered only by existing new-file cases).
- source_spec: `spec-6-6-new-file-bounded-by-static-graph.md`
  summary: Pre-existing `getChangedFiles` edges: non-ASCII filenames (**RESOLVED** 2026-07-15 — `getChangedFiles` now uses `git ... -z`), and an unborn HEAD (no commits) makes `git diff HEAD` fatal → null → full.
  evidence: The non-ASCII case is fixed (NUL-delimited output, no octal-quoting). The unborn-HEAD case remains but fails to the SAFE (full-suite) direction — a fresh repo with no commits just runs full until the first commit; add an empty-tree fallback ref if incremental-on-unborn-HEAD is ever wanted.

## Deferred from: spec-6-7-changed-since-last-run-baseline (2026-07-15)

- source_spec: `spec-6-7-changed-since-last-run-baseline.md`
  summary: **[for Story 6.8]** The since-last-run baseline treats a file *absent from the last snapshot* as `added`, so a tracked source that was created-since-last-run (or was merely unreadable at the previous snapshot write) then modified gets the Story-6.6 lenient `--changed` bounding rather than the conservative full-suite path a HEAD-baseline "modified" classification would give.
  evidence: Same failure mode and same mitigation as the 6.6 dynamic-import deferral above — a dynamic/DI/config edge from an existing test to such a file is invisible to `--changed`. The last-run baseline's `added` set is a (slightly larger) superset of `getChangedFiles`'s, so 6.8's confidence signal (mark bounded-new-file runs `degraded` + worker union-branch full-suite fallback) covers it. No new mechanism needed in 6.8 — just ensure the confidence signal keys off the same "new/unmapped source bounded only by `--changed`" condition regardless of which baseline produced it.
  evidence-tests: no test yet for a source new-since-snapshot-but-committed then modified, reached only by an existing test's dynamic import.
- source_spec: `spec-6-7-changed-since-last-run-baseline.md`
  summary: `listCandidateFiles`/`computeHashes` hash the ENTIRE tracked∪untracked candidate set fully into memory on every incremental run (once, at selection) — cost/latency on a large monorepo or one with large tracked binaries (`.png`/`.zip` not in the default ignore set).
  evidence: Correctness-safe (blocking synchronous work on the daemon thread, no under-select), but a real perf regression vs the pure `git diff` HEAD path for big repos. Mitigate with a `git ls-files -m`/mtime pre-filter to hash only plausibly-changed candidates, stream hashing (`createReadStream`) instead of `readFileSync`, and/or a size cap that treats oversized assets as always-changed. The Story-6.7 patch already halved the passes (capture once at selection instead of re-hashing post-run).
- source_spec: `spec-6-7-changed-since-last-run-baseline.md`
  summary: Minor git/FS edges in the snapshot module. The non-ASCII under-select (`git ls-files` newline-split → a non-ASCII path invisible in both snapshot and current) is **RESOLVED** 2026-07-15 (`listCandidateFiles` now uses `git ls-files -z`). Remaining, all SAFE (over-select) direction: a symlink-to-dir / submodule gitlink / FIFO candidate throws `EISDIR`/`EINVAL` in `computeHashes` → skipped → perpetually "changed"; `saveSnapshot`'s tmp name is `${target}.${pid}.tmp` (collision-safe only because per-project runs are queue-serialized — latent if a future non-queued caller appears; `randomUUID` would harden it).
  evidence: The one non-safe edge (non-ASCII) is fixed; the rest fail toward MORE running. A `stat`+skip for non-regular files and a `randomUUID` tmp suffix would tidy the remainder.

## Deferred from: spec-6-8-selection-confidence-signal (2026-07-15)

- source_spec: `spec-6-8-selection-confidence-signal.md`
  summary: **[for Story 6.10]** A `high` confidence verdict on the MAPPED path trusts coverage-map freshness — `entry.lastMeasured` is never consulted. A dynamic dependent (`await import`, dynamic `require`, DI, config) added AFTER the last measurement is invisible to both the stale map and the `--changed` static graph, so a regression only that dependent would catch can ship under a `high` verdict.
  evidence: Not a 6.8 regression — the SELECTION on the mapped path is identical to pre-6.8; 6.8 only adds the (sometimes-optimistic) `high` label. The real fix is coverage-map staleness tracking/invalidation, which is Story 6.10's remit ("a changed-but-unmeasured file marks the combined report degraded"). 6.10 should gate `high` on map freshness: a source whose `lastMeasured` predates its last change (or a configurable age) should degrade. Same static-graph blind spot as the ratified invariant-5 relaxation.
- source_spec: `spec-6-8-selection-confidence-signal.md`
  summary: False `high` on the "only test files changed" path when the changed file is a test-CLASSIFIED helper (a module under a `__tests__/` dir, or named `*.test/spec.*`, that contains no tests of its own but is imported by other test files). `isTestFile` treats it as a test, so `changedSources` is empty → `plan` returns `incremental`/`high`/`union:false`; the worker's explicit-files branch runs just that helper (0 tests) with NO empty→full fallback (only the union and lone-`--changed` branches have one). Dependent tests a broken helper would fail are skipped, under a `high` verdict.
  evidence: Pre-existing selection behaviour (AC1, Story 3.x) — 6.8 only surfaces the label. Explicitly out of 6.8's scope (the story surfaces the verdict from the selection outputs; selection-behaviour changes belong to 6.5/6.6/6.7). Fix options: (a) treat a changed test-helper as `union:true` so `--changed` catches its static importers; (b) add the empty→full fallback to the worker's explicit-files branch when the files came from incremental selection (not a user's explicit pin); (c) tighten `isTestFile`/track which test files actually contain tests. Narrow trigger (helper must live in a `__tests__/` dir or match the test glob) but a genuine false-high.
- source_spec: `spec-6-8-selection-confidence-signal.md`
  summary: Minor confidence/labelling edges, all low: (1) only-deleted-test-files → the worker runs nonexistent paths → 0 tests + success + `high` (the explicit-files branch again lacks the empty→full fallback); (2) `runPlan` attaches the plan-time verdict to a run of the FROZEN selection — accurate for what runs, but stale vs the current tree if the dev edited between dry-run and commit (by design, but worth a doc note); (3) the executionFallback→`high` override assumes the worker only ever labels a genuine full run `strategy:"full"` — true for all three current worker paths but unguarded (a future bounded-run-labelled-"full" would manufacture a false high); (4) the union branch's degraded reason says "bounded by the git static graph" even when `--changed` threw and `staticRun` collapsed to null (bounded nothing); (5) `strict` passed alongside `planId` is silently dropped (it's a plan-time flag baked into the frozen plan).
  evidence: All either safe-direction or cosmetic. (1) shares a fix with the only-test-files gap above (empty→full fallback on the explicit-files branch). (3) is worth a cheap assertion/comment guarding the "full ⇒ ran everything" invariant. (5) could error when both are supplied, or be documented.

## Deferred from: story-6-1-per-passing-test-detail (2026-07-15)

- source_story: `story-6-1-per-passing-test-detail.md`
  summary: The UI `statusBanner` (and pre-existing `card`) interpolate `r.total`/`r.passed`/`r.failed` without `esc()`; the project view rebuilds `app.innerHTML` on every SSE tick, dropping scroll position/row selection, and the live banner (from `snapshot.projects`) can transiently disagree with the fetched run table.
  evidence: Both LOW/cosmetic. The unescaped fields are daemon-computed integers (not user input), and this mirrors the existing `card()` style — divergence wasn't worth it. The re-render/skew is pre-existing `renderProject` behaviour, not worsened by the banner; a future pass could diff-render or source the banner and table from one payload.

## Deferred from: story-6-2-on-disk-run-history-persistence (2026-07-15)

- source_story: `story-6-2-on-disk-run-history-persistence.md`
  summary: Daemon startup rehydrates history with SYNCHRONOUS `readdirSync`+`readFileSync` over every history file for every registered project BEFORE the HTTP port binds, so a project with a very large history dir (or a huge file) delays startup / blocks the event loop.
  evidence: LOW — `pruneHistory` runs on every write and keeps each dir ≤ the cap (~50), so in steady state only ~50 small files are read per project. The only slow case is a pathological pre-existing dir on the very first startup after upgrade. Mitigate by pre-selecting the newest `cap` filenames (cheap `stat`) before parsing, or moving rehydration off the pre-bind path (lazy per-project load on first history query).

## Deferred from: story-6-3-coverage-report-in-results-and-ui (2026-07-15)

- source_story: `story-6-3-coverage-report-in-results-and-ui.md`
  summary: **AC4 (coverage threshold-gate signal) — RESOLVED 2026-07-15** (after Story 6.10). The worker reads the project's own `coverage.thresholds` and reports `coverage.thresholds` + `coverage.thresholdsMet` (asserted only at high confidence; undefined + "run a full pass" when degraded).
  evidence: DONE for the global numeric-% form (incl. the `100: true` shorthand). Residual (still deferred, LOW): per-glob thresholds, `perFile`, and negative (max-uncovered-count) thresholds are read but NOT turned into a verdict — `parseGlobalThresholds` surfaces only what it can compare to the combined percentages rather than invent one. A future pass could evaluate per-glob/perFile against the per-file rows.
- source_story: `story-6-3-coverage-report-in-results-and-ui.md`
  summary: **RESOLVED by Story 6.10** — the per-run report was superseded by the whole-project COMBINED report (union of each test file's latest measurement), so coverage is no longer an unqualified subset number.
  evidence: Combined coverage merges via istanbul across all tests' latest data and flags stale/unmeasured sources as degraded confidence. Residual `all: false` note (never-imported files absent from the total) remains a minor accuracy caveat — see the 6.10 residual entry below.
- source_story: `story-6-3-coverage-report-in-results-and-ui.md`
  summary: The per-file coverage table (`result.coverage.files`) is unbounded — a large repo's coverage run persists (Story 6.2) and re-renders a very large array, unlike the Story-6.1 `tests` list which is capped.
  evidence: LOW-MEDIUM. Bound it like `tests` (cap + a `filesTruncated` flag, ideally keeping the lowest-coverage files as the most actionable) so history records and UI payloads stay bounded. Also cosmetic: files outside the project root render as `../..` paths (`path.relative` fallback only fires on identical paths).

## Deferred from: story-6-10-combined-incremental-coverage (2026-07-15)

(6.10 itself is DONE — the user authorized `istanbul-lib-coverage`, unblocking the accurate merge.
These are residual edges the review surfaced, all safe-direction or narrow.)

- source_story: `story-6-10-combined-incremental-coverage.md`
  summary: Lost-update (6.7 class): a source edited BETWEEN its coverage measurement and the post-run source hashing gets a stored hash matching the post-edit disk while the persisted coverage reflects the pre-edit run → not flagged stale → `high` confidence with slightly-stale numbers.
  evidence: Narrow (edit during a long coverage run). Fix by hashing each source at the moment its test is measured (inside the measure callback) rather than once after the whole build. Same family as the accepted 6.7 window.
- source_story: `story-6-10-combined-incremental-coverage.md`
  summary: `coverage-data.json` and the per-file coverage list inside each persisted history record grow with project size; deleted TEST files are now pruned, but per-run I/O still hashes every source any surviving test measured, and large projects bloat every `.test-mcp/history/<runId>.json` (Story 6.2).
  evidence: MEDIUM on very large repos. Consider: prune `sourceHashes`/rows for sources no longer on disk; store combined coverage once (latest) rather than per-history-record, or trim the per-file list from history and keep only total+confidence there.
- source_story: `story-6-10-combined-incremental-coverage.md`
  summary: Minor accuracy edges: a 0-statement source's istanbul pct sentinel is coerced to 0 and folded into the total (slight under-report); a run where ALL measurements fail but prior data exists reports the carried combined numbers (arguably fine if sources unchanged, but it "measured nothing" this run).
  evidence: LOW. The confidence signal covers the second case when sources changed; when unchanged, reporting carried coverage is reasonable.

## Testing infrastructure (2026-07-15)

- source: Epic 6 dev-auto runs
  summary: `test/watch.test.ts` ("re-runs affected tests when a source file changes") intermittently timed out (~60s poll) when the FULL suite runs in parallel — worker/CPU starvation, not a logic bug. It passes reliably in isolation (~2s).
  evidence: MITIGATED 2026-07-15 by raising its poll timeout to 150s / test timeout to 180s so the worker fork+run isn't cut off under full-suite contention (it still completes in ~2s normally; the headroom only matters under load). This TOLERATES the contention rather than removing it — a genuine hang now takes up to 150s to surface. A cleaner root-cause fix remains available: give the worker-forking integration tests their own non-parallel Vitest pool (or lower `maxWorkers` for them) so they don't starve each other. Revisit if the timeout bump proves insufficient in CI.
