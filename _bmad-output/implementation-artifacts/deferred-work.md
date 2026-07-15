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
  summary: A run's `TestResult` object is shared by reference across `recordRun` (history), `setRunState` (`lastResult`), and `resolve` (the returned value); any later in-place mutation of one silently corrupts the others.
  evidence: Pre-existing pattern (predates Story 6.4); the 6.4 stamp mutates `result.selection` before all three consumers, which is consistent today but entrenches the shared-mutable-reference hazard. A defensive clone of the run result before fan-out would remove the latent risk.

## Deferred from: spec-6-5-ignore-test-irrelevant-changes (2026-07-15)

- source_spec: `spec-6-5-ignore-test-irrelevant-changes.md`
  summary: Default-ignoring non-code files (`*.md`/`*.txt`/`docs/**`) can silence a rerun for a *fixture-driven* test that reads such a file, and an all-filtered changeset is indistinguishable from a clean tree (no signal).
  evidence: The filter runs before `plan()`, so a non-code fixture a test reads at runtime — which coverage never maps — is dropped instead of forcing the "unknown source → full suite" safeguard. Ratified as the intended "ignore non-code" default, but Story 6.8 (confidence signal) should surface when a run's entire changed set was filtered so a fixture-only edit isn't a silent no-op. Users can also keep specific paths out of the default set (future: allow un-ignoring).
- source_spec: `spec-6-5-ignore-test-irrelevant-changes.md`
  summary: The `.test-mcp-ignore` matcher supports only a documented subset of gitignore syntax; several forms are unsupported and fail toward MORE running.
  evidence: `!` negation compiles to a literal, `?`/`[…]` are literal, trailing-slash `dir/` and bare `dir` don't match a directory's contents (need `dir/**`), leading `**/x` and middle `a/**/b` don't collapse zero dirs, and backslash-separated patterns don't match POSIX paths. All fail safe (nothing excluded → more runs), but silently — a fuller matcher or startup validation/warning would help.
- source_spec: `spec-6-5-ignore-test-irrelevant-changes.md`
  summary: keep-always allowlist is not exhaustive for all build/test configs, and `readIgnorePatterns` swallows non-ENOENT errors.
  evidence: `babel.config.json`, `jest.config.json`, `.mocharc.*`, `.swcrc`, `.env*`, `vitest.workspace.*` are not on keep-always (safe unless a broad user pattern like `*.json` drops them). A present-but-unreadable `.test-mcp-ignore` (EACCES/EISDIR) is treated as absent with no warning.

## Deferred from: spec-6-6-new-file-bounded-by-static-graph (2026-07-15)

- source_spec: `spec-6-6-new-file-bounded-by-static-graph.md`
  summary: **[for Story 6.8]** Bounding a NEW source by the git `--changed` static graph can silently under-run when the new file is reached via a dynamic import / side-effect / DI / config, and the worker's UNION branch has no full-suite fallback (unlike the lone-`--changed` branch), which `alwaysRun` can force it into.
  evidence: `--changed` is a static import graph; a never-measured new file has no coverage-map signal, so a dynamic edge from an existing unchanged test is invisible → that test isn't selected and a regression can ship green. This is the ratified invariant-5 relaxation whose designed mitigation is **6.8's confidence signal** — 6.8 MUST mark bounded-new-file runs as `degraded` confidence (so the agent runs a full pass), and the worker's union branch should gain the same full-suite fallback the `files.length===0` `--changed` branch has. Land these in 6.8.
  evidence-tests: no test yet for (a) a new source reached only by an existing test's dynamic import, (b) the `alwaysRun`-present case removing the worker fallback, (c) a staged-new file (the getChangedFiles staged-add patch is covered only by existing new-file cases).
- source_spec: `spec-6-6-new-file-bounded-by-static-graph.md`
  summary: Pre-existing `getChangedFiles` edges: git `core.quotePath` octal-quotes non-ASCII filenames (never match map keys → misclassified unknown → full), and an unborn HEAD (no commits) makes `git diff HEAD` fatal → null → full.
  evidence: Both predate 6.6 and fail to the SAFE (full-suite) direction, so they're correctness-safe but defeat incremental selection for those repos. Fix with `-z`/`core.quotePath=false` parsing and an empty-tree fallback ref respectively.

## Deferred from: spec-6-7-changed-since-last-run-baseline (2026-07-15)

- source_spec: `spec-6-7-changed-since-last-run-baseline.md`
  summary: **[for Story 6.8]** The since-last-run baseline treats a file *absent from the last snapshot* as `added`, so a tracked source that was created-since-last-run (or was merely unreadable at the previous snapshot write) then modified gets the Story-6.6 lenient `--changed` bounding rather than the conservative full-suite path a HEAD-baseline "modified" classification would give.
  evidence: Same failure mode and same mitigation as the 6.6 dynamic-import deferral above — a dynamic/DI/config edge from an existing test to such a file is invisible to `--changed`. The last-run baseline's `added` set is a (slightly larger) superset of `getChangedFiles`'s, so 6.8's confidence signal (mark bounded-new-file runs `degraded` + worker union-branch full-suite fallback) covers it. No new mechanism needed in 6.8 — just ensure the confidence signal keys off the same "new/unmapped source bounded only by `--changed`" condition regardless of which baseline produced it.
  evidence-tests: no test yet for a source new-since-snapshot-but-committed then modified, reached only by an existing test's dynamic import.
- source_spec: `spec-6-7-changed-since-last-run-baseline.md`
  summary: `listCandidateFiles`/`computeHashes` hash the ENTIRE tracked∪untracked candidate set fully into memory on every incremental run (once, at selection) — cost/latency on a large monorepo or one with large tracked binaries (`.png`/`.zip` not in the default ignore set).
  evidence: Correctness-safe (blocking synchronous work on the daemon thread, no under-select), but a real perf regression vs the pure `git diff` HEAD path for big repos. Mitigate with a `git ls-files -m`/mtime pre-filter to hash only plausibly-changed candidates, stream hashing (`createReadStream`) instead of `readFileSync`, and/or a size cap that treats oversized assets as always-changed. The Story-6.7 patch already halved the passes (capture once at selection instead of re-hashing post-run).
- source_spec: `spec-6-7-changed-since-last-run-baseline.md`
  summary: Minor git/FS edges in the snapshot module, all failing to the SAFE (over-select) direction: `git ls-files` is newline-split (a `core.quotePath` non-ASCII path is skipped in both snapshot and current → invisible → *under-select* — the one exception, shared with `getChangedFiles`, fix with `-z`); a symlink-to-dir / submodule gitlink / FIFO candidate throws `EISDIR`/`EINVAL` in `computeHashes` → skipped → perpetually "changed"; `saveSnapshot`'s tmp name is `${target}.${pid}.tmp` (collision-safe only because per-project runs are queue-serialized — latent if a future non-queued caller appears; `randomUUID` would harden it).
  evidence: Except the non-ASCII case (shared with 6.6's deferred `-z` fix), all fail toward MORE running. Bundle the `-z`/`core.quotePath=false` parsing fix with the 6.6 deferral so both `getChangedFiles` and `listCandidateFiles` are corrected together.

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
  summary: **AC4 (coverage threshold-gate signal) DEFERRED.** A run does not report a distinct "coverage gate failed" signal (e.g. `coverage.thresholdsMet: false`) when the project's Vitest thresholds aren't met.
  evidence: `coverage-summary.json` exposes achieved percentages but not the project's configured thresholds, and `measureCoverageSummary` passes `thresholds: undefined` so the project gate can't fail our measurement pass. A clean signal requires additionally reading the project's Vitest `coverage.thresholds` config (including per-file and glob-scoped thresholds) and comparing — a separate, non-trivial piece confirmed by review as not trivially available from what 6.3 exposes. Implement alongside/after Story 6.10, whose whole-project combination gives the correct base numbers to gate on.
- source_story: `story-6-3-coverage-report-in-results-and-ui.md`
  summary: **[for Story 6.10]** A per-run coverage report is shown UNQUALIFIED as "coverage", but it reflects only the tests that ran (`all: false`), so (a) an incremental run's number is a subset, not project coverage, and (b) even a full run's overall % excludes never-imported source files, inflating it vs true project coverage.
  evidence: MEDIUM accuracy/labelling. Story 6.10 (combined incremental coverage) is the designed fix — union each test file's latest measurement into a whole-project picture, flag stale/unmeasured parts as degraded confidence (6.8). Until then the number is honest about "what ran" but could be misread as project coverage; 6.10 should add whole-project framing (and consider `all: true` for the baseline full run).
- source_story: `story-6-3-coverage-report-in-results-and-ui.md`
  summary: The per-file coverage table (`result.coverage.files`) is unbounded — a large repo's coverage run persists (Story 6.2) and re-renders a very large array, unlike the Story-6.1 `tests` list which is capped.
  evidence: LOW-MEDIUM. Bound it like `tests` (cap + a `filesTruncated` flag, ideally keeping the lowest-coverage files as the most actionable) so history records and UI payloads stay bounded. Also cosmetic: files outside the project root render as `../..` paths (`path.relative` fallback only fires on identical paths).

## Testing infrastructure (2026-07-15)

- source: Epic 6 dev-auto runs
  summary: `test/watch.test.ts` ("re-runs affected tests when a source file changes") intermittently times out (~60s poll) when the FULL suite runs in parallel — worker/CPU starvation, not a logic bug. It passes reliably in isolation (~1.6s) and on a clean full run.
  evidence: Recurs across several Epic 6 runs. Not introduced by any Epic 6 story. Options: give the watch test its own non-parallel pool/`describe.sequential`, raise its internal poll timeout, or run watch tests in a separate Vitest project. Flaky-green risk in CI — worth stabilizing before relying on `pnpm test` as a hard gate.
