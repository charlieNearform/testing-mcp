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
