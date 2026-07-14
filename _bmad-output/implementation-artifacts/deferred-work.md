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
