---
baseline_commit: 0114c698f87be411905715eba9ee25878d1fd14c
---

# Story 3.8: Unified Single-Pass Coverage, Reverse-Map Retirement

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an AI agent,
I want every `run_tests` request — full or incremental — to execute as exactly one Vitest pass,
with coverage measurement available only on a full-suite run,
So that incremental iteration never pays a coverage-measurement cost (the thing actually causing
unnecessary slowdowns during fast development loops), and a full-suite coverage gate costs the
same as running the suite once.

## Context

Epic 3's coverage design has been reopened three times this cycle. Story 3.2 shipped naive
per-test-file measurement (spike-proven correct, but never the "mandatory" single-pass design
`docs/architecture.md` called for). Story 3.7 fixed the full-suite case specifically (one native
Vitest pass, no per-file attribution) but left incremental's per-file measurement path untouched,
reasoning that incremental selections stay small enough to bound the cost. That reasoning doesn't
survive a harder constraint confirmed with the user this session: **every run, of any strategy,
executes exactly one Vitest pass — no exceptions, ever.** Today, an incremental run with explicit
`coverage: true` still does `1 + N` invocations (one real-results pass, one per selected file) —
a smaller violation than pre-3.7, but still a violation.

Investigating the fix surfaced the real, unavoidable consequence: a single Vitest pass can produce
an aggregate coverage **percentage** for any file set, but never **per-test attribution** (which
test covers which source) — that requires measuring files separately to tell them apart, which is
exactly what's now forbidden. So this story doesn't just fix incremental's double-pass — it
retires the reverse coverage map entirely, confirmed explicitly with the user, validated against a
real AI-agent workflow trace (fast incremental loop with no coverage, coverage only on a terminal
full-suite gate — proving no real usage pattern needs incremental coverage) and a live experiment
proving the fallback plan is sound (see Dev Notes: "the `related` mechanism").

This also touches Epic 7 (Runner Plugin API, not yet implemented — Stories 7.1-7.6 are all
`ready-for-dev`). `epics.md` has been annotated at 7.1, 7.3, and 7.6 to keep that epic's future
implementation aligned with what this story leaves behind. Do not implement Epic 7 here — only
keep the Vitest-specific mechanics cleanly encapsulated so that epic's eventual extraction is
smooth, per the Dev Notes below.

## Acceptance Criteria

1. **Given** any `run_tests` request, full or incremental, **when** it executes, **then** exactly
   one Vitest invocation runs — never more — regardless of whether coverage is requested. **The
   sole exception**: a `related`-based selection that resolves to zero actual test files despite
   non-empty changed input (confirmed live: a file nothing statically depends on, e.g. an orphan
   source) falls back to a full run as a second invocation — an already-existing safety net
   (architecture invariant 5, "never silently skip"), not a new one. This must remain the ONLY
   scenario anywhere in the system that runs more than one Vitest pass for a single request.

2. **Given** an incremental/selective request (a resolved selection that is not a genuine
   full-suite run), **when** `coverage: true` is supplied (via `run_tests`'s param or any other
   means), **then** the request is rejected with a structured `ValidationError` naming the
   constraint ("coverage is only available on a full-suite run") — never silently ignored, never
   silently downgraded to no-coverage without telling the caller.

3. **Given** a full-suite request, **when** `coverage` is omitted, **then** it defaults to `true`
   unconditionally (no map-exists gate — coverage is uniformly cheap now, one pass either way).

4. **Given** an incremental request with changed files (source or test), **when** selection
   resolves, **then** the affected-tests determination is made via Vitest's `related: string[]`
   config field (an explicit file list resolved through the static import graph — confirmed live
   to skip Vitest's own git lookup entirely), fed by the orchestrator's existing since-last-run
   snapshot delta (`src/snapshot/index.ts`) — **not** Vitest's `changed: true` (which does its own
   git diff and has no memory of what a prior run already validated — confirmed live to
   incorrectly re-select an already-validated file when a second, unrelated file is later edited
   without committing either).

5. **Given** the reverse coverage map, per-file measurement, setup-baseline subtraction,
   unmeasurable-tests tracking, and the per-test combined-coverage union/staleness machinery,
   **when** this story ships, **then** all of it is deleted as dead code (see Task list) — not
   merely left unused.

6. **Given** a project with dynamic-import syntax anywhere (`hasDynamicImportSyntax`, unchanged
   from today), **when** an incremental selection resolves via `related`, **then** confidence is
   still flagged `degraded` for a NEW/modified source outside what `related` can prove reached —
   this caveat is about the static graph's own blind spot, not the now-removed map, and survives
   unchanged.

7. **Given** watch mode, **when** it runs, **then** `fastMode`/coverage-in-watch is removed
   entirely — watch mode never requests coverage (it always runs incremental).

## Tasks / Subtasks

- [x] Task 1: IPC contract changes (AC: 1, 4)
  - [x] 1.1 `src/types/ipc.ts` — `ToWorker`'s `"run"` variant: replace `changed: boolean` with
        `relatedFiles?: string[]` (present + non-empty = related-based incremental selection;
        absent = full suite or explicit files). Remove `allTestsRun` if nothing besides the
        deleted coverage-phase code ever read it (confirm via grep — Story 3.7's Dev Notes flagged
        it as already-unused dead weight; if still genuinely unused, delete here). Remove the
        `"phase-progress"` / `phase: "coverage"` `FromWorker` variant entirely — the unified pass
        reports through the existing `"progress"` message like any other run; there is no more
        separate blind coverage phase to heartbeat. Remove `coverageDelta` from the `"result"`
        `FromWorker` variant and `CoverageDelta` type — confirmed zero consumers downstream of the
        IPC boundary (Story 3.7's own investigation), and there is no more per-test delta to carry
        now that per-file attribution is gone entirely.
  - [x] 1.2 Update both Zod schemas (`ToWorkerSchema`, `FromWorkerSchema`) to match.
- [x] Task 2: Selection Engine simplification (AC: 4, 6)
  - [x] 2.1 `src/selection/index.ts` — remove `SelectionInput.map: CoverageMapFile | null` and
        `strict?: boolean` entirely (both are map-uncertainty concepts with nothing left to be
        uncertain about). Remove the `CoverageMapFile` import.
  - [x] 2.2 Collapse `SelectionPlan`'s three-way split (`full`/`changed-only`/`incremental`) —
        `changed-only` and the "only test files changed" incremental case both become the SAME
        `related`-based path once `related` handles direct test-file matches and source-file
        dependency matches uniformly (confirmed live). Keep: can't-determine-changed-files → full;
        no changes → incremental/empty; a changed file that's a keep-always/full-suite-trigger
        concept — re ­examine whether ANY "full-suite trigger" concept survives without the map
        (it was `map.fullSuiteTriggers`, populated by setup-baseline subtraction — gone). Simplify
        to: any non-empty changed-file set → `{ strategy: "incremental", relatedFiles: changedFiles
        }`, confidence `high` unless `dynamicImportsPresent` and a source outside what's already
        proven reached is involved (keep this ONE caveat, per AC6 — re-derive its exact trigger
        condition from the current `mightMissDynamicImport`/`addedFiles` logic, adapted to a world
        with no map to check "unmapped" against; a NEW source with dynamic imports present in the
        project is the residual case that still needs flagging).
  - [x] 2.3 Update `test/selection.test.ts` for the simplified `plan()` shape — this file needs a
        substantial rewrite, not incremental patching; re-derive its test cases from the new,
        smaller branch set rather than trying to preserve every existing test's structure.
- [x] Task 3: Orchestrator changes (AC: 1, 2, 3, 4)
  - [x] 3.1 `src/orchestrator/index.ts` (`resolveSelection`, starts ~line 451 — confirm current
        line) — remove `loadCoverageMap`
        call and the `map`/`strict` fields passed to `SelectionEngine.plan`; pass `changedFiles`
        (the existing since-last-run delta, unchanged mechanism) as the new `relatedFiles` plan
        input. Remove `hasDynamicImportSyntax`'s conditional-on-map gating (`docs` note: "only
        worth checking when there's a map to combine it with") — it's now unconditionally
        relevant whenever a plan involves a changed source, map or no map.
  - [x] 3.2 `src/orchestrator/index.ts` (`startRun`, `const coverage = opts.coverage ?? ...` —
        currently line 300, confirm current line before editing) — coverage default becomes:
        `const coverage = opts.coverage ?? sel.strategy === "full";` (no `loadCoverageMap` gate —
        full always defaults on, unconditionally). When `opts.coverage === true` and
        `sel.strategy !== "full"`, throw a new `SelectionError` class (mirror `WorkerError`/
        `PlanError`'s existing shape at `src/orchestrator/index.ts:37-52` — a `readonly code`
        plus message) instead of a plain `Error`. Add an `instanceof SelectionError` branch in
        `src/mcp/server.ts`'s `run_tests` catch block (currently only checks `PlanError`, ~line
        277 — confirm current line) mapping it to the `ValidationError` MCP error code, matching
        the existing `PlanError` → `PlanExpired` pattern right next to it.
  - [x] 3.3 Remove `strict` from `runTests`/`startRun`/`plan`'s option types and their call chains.
  - [x] 3.4 Keep `getTestInventoryFileCount`/the size-based full-run escalation (`src/selection/index.ts`,
        added this session) unchanged — it's orthogonal to the map (already didn't depend on it)
        and still bounds a `related` list that's grown large enough that Vitest's own graph
        resolution cost approaches just running everything.
- [x] Task 4: Worker — unified single-pass mechanism (AC: 1, 2, 3, 4)
  - [x] 4.1 `src/worker/index.ts` — delete `measureCoverage`, `measureSetupBaseline`,
        `buildAndPersistCoverageMap`, `buildNativeFullSuiteCoverage`, `persistAndCombine`, and the
        entire `withCoverageHeartbeat`/`COVERAGE_HEARTBEAT_INTERVAL_MS`/`COVERAGE_HEARTBEAT_MAX_MS`/
        `NATIVE_COVERAGE_HEARTBEAT_FLOOR_MS`/`TEST_MCP_FULL_COVERAGE_BUDGET_MS` machinery — the
        unified pass reports real per-test progress via `runOnce`'s existing reporter, so there is
        no more blind phase needing a synthetic heartbeat. Delete every `logMemory` call specific
        to the deleted coverage phase (keep `handle-run-start`, generalize or drop the rest — this
        diagnostic instrumentation was added to debug the per-file path specifically and mostly
        stops being meaningful once it's gone).
  - [x] 4.2 Rewrite `runOnce`'s `{ changed: true }` call sites (`src/worker/index.ts:573-648`,
        `runVitest`) to accept `relatedFiles?: string[]` instead of `changed: boolean`, passing
        `{ related: relatedFilesAbsolute }` to `startVitest` instead of `{ changed: true }`. The
        "union" branch (`opts.changed && opts.files.length > 0`, lines 573-609) becomes
        unreachable once nothing populates both a map-derived file list AND a static-graph flag
        simultaneously (confirm this via the new `resolveSelection`/`SelectionEngine.plan` shapes
        from Task 2/3 before deleting — do not delete based on assumption alone). Collapse
        `runVitest` to: related-based selection (with the existing "nothing matched → fall back to
        full, never a silent skip" safety net, lines 621-629, adapted) OR explicit files/full suite
        (lines 632-647, unchanged shape).
  - [x] 4.3 Add the new unified coverage mechanism: when `msg.coverage` is true (only ever true for
        a genuine full-suite request per Task 3.2's validation), call `runOnce` with `coverage:
        {enabled:true, provider:"v8", all:false, reporter:["json"], reportsDirectory, thresholds:
        undefined}` merged into its `extraOptions` (reuses `runOnce`'s existing shallow-merge
        support for this — already proven in Story 3.7's `buildNativeFullSuiteCoverage`, just now
        the SAME call that also produces real results, not a second one). Build the `TestResult`
        via the already-exported `mapModulesToResult`/`mapFailureDetails` exactly as `runVitest`'s
        own full-suite branch does. Read `coverage-final.json` from `reportsDirectory` afterward
        and build the coverage report via the existing `buildNativeCoverageReport` (Story 3.7,
        keep as-is — still correct, still the right shape) merged onto the result. Log at entry and
        at each silent-degrade branch (`!vitest`, missing file, corrupt JSON) — Story 3.7 shipped
        this function with zero diagnostic logging, which is exactly what caused this story's
        second reported symptom (a real run's coverage report went silently missing with no trace
        in `debug-memory.log`); do not repeat that gap here.
  - [x] 4.4 `handleRun` — collapse to one call path: resolve `relatedFiles`/`files`/`coverage` from
        `msg`, call the unified mechanism once, return its result. No more two-phase
        `runVitest`-then-`buildAndPersistCoverageMap` structure.
- [x] Task 5: Delete the reverse-map/combined-coverage modules (AC: 5)
  - [x] 5.1 Delete `src/coverage/index.ts` entirely (`buildCoverageMap`, `CoverageMapFile`,
        `loadCoverageMap`/`saveCoverageMap`/`coverageMapPath`, `extractCoveredSources`,
        `FileMeasurement`, `MeasurementSummary`) — zero remaining callers once Tasks 2-4 land.
        `isTestFile` is ALSO exported from `src/selection/index.ts` already (a separate,
        independent implementation) — confirm nothing outside the deleted module needs THIS
        file's copy before removing it; if `src/worker/index.ts`'s `buildNativeCoverageReport`
        still needs an `isTestFile` check, point it at `src/selection/index.ts`'s copy.
  - [x] 5.2 Delete `src/coverage/combined.ts`'s per-test-union machinery (`CoverageDataFile`,
        `TestCoverage`, `updateCoverageData`, `combineCoverage`, `loadCoverageData`/
        `saveCoverageData`/`coverageDataPath`, `coveredSourceFiles`) — zero remaining callers.
        Relocate the two still-needed pure helpers (`parseGlobalThresholds`, `meetsThresholds`)
        into `src/worker/index.ts` directly (the only remaining consumer) rather than leaving a
        near-empty module behind; delete `src/coverage/combined.ts` once empty.
  - [x] 5.3 `src/types/contracts.ts` — simplify `TestResult["coverage"]`: remove `combined`, and
        each file's `fresh`/`stale` (dead once there's no per-test union to describe staleness
        against — every file in a single-pass report is definitionally fresh). Update the doc
        comment to describe only the one remaining case (native single pass, full-suite only).
- [x] Task 5b: Remove the now-dead coverage-phase live-progress plumbing (AC: 1, 5)
  - [x] 5b.1 `src/types/ipc.ts` — removing the `"phase-progress"` `FromWorker` variant (Task 1.1)
        breaks every consumer; this task is what makes that removal safe rather than a
        typecheck-breaking half-measure.
  - [x] 5b.2 `src/orchestrator/index.ts` — remove `LivePhase` interface, `LiveRunState.phase`, the
        `"phase-progress"` message handler branch, and `getLiveRun`'s `phase` field — all fed
        exclusively by the deleted blind coverage-phase heartbeat; the unified pass's real
        per-test progress already flows through the existing `"progress"`/live-tests mechanism.
  - [x] 5b.3 `src/ui/index.ts` — remove `LiveView.phase`, `uiSnapshot`'s phase propagation, and
        `phaseProgressBlock` (and its call site in `renderLiveRun`) — the "Measuring coverage"
        progress bar has nothing left to report; a full-suite run's real progress already shows
        via the existing live-tests list, same as any other run.
- [x] Task 6: Watch mode (AC: 7)
  - [x] 6.1 `src/watch/index.ts` — remove `fastMode` from `WatchOptions`/`WatchStatus`/`start()`;
        the incremental run it triggers never requests coverage (matches AC2's rejection — watch
        mode must never even attempt to pass `coverage: true`).
  - [x] 6.2 `src/mcp/server.ts` — remove `start_watch`'s `fastMode` param.
- [x] Task 7: MCP schema + docs (AC: 2, 3)
  - [x] 7.1 `src/mcp/server.ts` — rewrite `run_tests`'s `coverage` param description (no map-exists
        gate; full-suite-only; explain the rejection behavior for AC2). Remove the `strict` param
        (Task 3.3).
  - [x] 7.2 `docs/usage.md` — rewrite the "Agent instructions" block and surrounding examples
        (already rewritten twice this cycle for the prior two coverage redesigns; this is the
        version that should actually stick, since the design is now a hard invariant, not a
        default) and the watch-mode section (remove `fastMode`).
  - [x] 7.3 `docs/architecture.md` — rewrite the "Coverage Map Build" section and its Open Risk
        entry to describe the retired state, not "resolved for full-suite, residual for
        incremental" (Story 3.7's framing is now itself superseded).
  - [x] 7.4 Leave `docs/prd.md`/`docs/patterns.md`/`README.md` mentions as historical record with
        a brief superseded pointer to this story, matching the existing pattern for Stories
        3.2-3.7 — do not rewrite the PRD's original rationale, annotate it.
- [x] Task 8: Tests (AC: all)
  - [x] 8.1 Delete: `test/coverage-map.test.ts`, `test/coverage-unmeasurable.test.ts`,
        `test/coverage-build.test.ts`, `test/combined-coverage.test.ts` — all test deleted
        machinery with no adaptable equivalent.
  - [x] 8.2 Rewrite: `test/coverage-baseline.test.ts` — setup-baseline subtraction (the mechanism)
        no longer exists, but confirmed via a live experiment this story's investigation ran that
        Vitest's own dependency graph ALREADY resolves a setup file's dependents correctly with
        NO custom logic needed: `related: [setupFileAbs]` against a 2-test-file fixture where only
        `vitest.config.ts`'s `setupFiles` (not a direct import) connects them selected BOTH test
        files, not zero. Rewrite this test to positively assert exactly that (a setup-file change
        selects every test file that uses it) rather than leaving it an open question — the
        behavior is confirmed working, just via a different, simpler mechanism than before.
        `test/git-selection.test.ts` / `test/selection-integration.test.ts` (the since-last-run
        snapshot mechanism itself is UNCHANGED and still needs full coverage — just via `related`
        instead of the old map/changed-only split), `test/orchestrator-selection-reason.test.ts`
        (exercises `map`/`strict`/`changed-only` throughout — rewrite its `selection.reason`
        assertions against the new `related`-based reason strings), `test/watch.test.ts` (remove
        the `fastMode` case).
  - [x] 8.3 Keep and adapt: `test/worker-native-full-coverage.test.ts` (the unified mechanism's
        correctness — percentages, `thresholdsMet`, no map file ever written since the module
        that wrote it no longer exists) and `test/worker-coverage-heartbeat.test.ts` (rename/trim
        — most of its heartbeat-specific assertions no longer apply since there's no more separate
        coverage phase; keep whatever still exercises real behavior, e.g. pool-start heartbeat).
  - [x] 8.4 Add: a live test proving `related`-based selection does NOT re-select an
        already-validated file when a second file changes without committing either (the exact
        regression this story's investigation found in Vitest's `changed`, adapted as a positive
        test of the fix) — mirrors the real experiment run during this story's investigation.
  - [x] 8.5 Add: a test proving `coverage: true` on a non-full-suite request is rejected with a
        structured error (AC2), and that omitting `coverage` on incremental never measures it
        even when a coverage-enabled full run happened moments earlier (no lingering state).

## Dev Notes

- **The `related` mechanism (this story's central technical finding, verified live, not
  documentation-sourced):** Vitest's public `UserConfig` has a `related?: string[] | string`
  field (confirmed in `node_modules/vitest/dist/chunks/reporters.d.DtoKVV2s.d.ts`), honored by the
  programmatic `startVitest`/`createVitest` API — NOT exposed as a CLI flag in this pinned version
  (4.1.9), so `grep`-ing for `--related` usage examples will find nothing; go by the type +
  the internal resolution logic instead (`node_modules/vitest/dist/chunks/cli-api.24X8XwN1.js:
  11485-11506`: `if (config.changed && !config.related) { config.related = await
  findChangedFiles(...) }` — i.e. `related`, when already set, makes Vitest skip its OWN git
  lookup and resolve dependents via `deps.has(path)` against exactly the given files). Verified
  with a real disposable fixture: two files both uncommitted-changed, `startVitest(..., {related:
  [oneOfThem]})` ran ONLY that file's test, completely ignoring the other's uncommitted change —
  proving this is genuinely git-independent, unlike `changed: true` (which was ALSO verified live
  to re-select an already-validated file the moment a second, unrelated file is edited without
  committing either — the exact bug this story exists to avoid reintroducing). Two more
  live-verified findings that directly de-risk Task 2/8.2: (a) a setup file (`test.setupFiles`,
  never directly `import`-ed by any test) still correctly resolves as a dependency of every test
  that uses it — `related: [setupFileAbs]` against a 2-file fixture selected BOTH test files, not
  zero — Vitest's own graph already tracks this, no custom full-suite-trigger logic needed; (b) a
  genuine orphan file (nothing statically depends on it) correctly resolves to zero matches,
  confirming the empty-match-falls-back-to-full safety net (AC1's sole exception) is both
  necessary and correctly triggered, not just theoretical.
- **Feed `related` from the EXISTING since-last-run snapshot, not a new mechanism.**
  `src/snapshot/index.ts`'s `selectionDelta`/`getChangedFiles` (Story 6.7, unchanged by this
  story) already compute exactly the right file list — this story's job is routing that list to
  Vitest's `related` instead of discarding it in favor of Vitest's own `changed: true` lookup for
  the no-map fallback (`resolveSelection`'s `changed-only` branch, `src/orchestrator/index.ts:483-486`
  today). Do not build a new "what changed" detector — the existing one is correct and load-bearing.
- **Why coverage is a hard rejection, not a silent ignore, on non-full runs (AC2):** matches this
  codebase's own "fail loud and specific" standard (`CLAUDE.md`). A caller who explicitly asked for
  coverage and got silently downgraded to none would have no way to notice; a caller told
  "coverage is full-suite-only" learns the constraint once and adjusts.
- **Epic 7 alignment (do not implement Epic 7 here, but keep it easy later):** `epics.md`'s Story
  7.1 now expects the eventual `RunnerPlugin.affectedTests(files: string[])` to take an explicit
  file list (mirroring `related`, not a git ref) and Story 7.3 expects the Vitest plugin to report
  `capabilities.coverage: "summary"`. Keep the unified single-pass mechanism (Task 4) and the
  `related`-based resolution (Task 2/4.2) as clearly separable, cleanly-named pieces of
  `src/worker/index.ts` — e.g. don't inline `related`-list construction deep inside unrelated
  logic — so a future 7.1 extraction can lift them into `src/runners/vitest/` with minimal
  reshaping. No new abstraction/interface needs to exist yet; just don't make the future one harder.
- **What survives untouched:** `src/snapshot/index.ts` (since-last-run mechanism), the size-based
  full-run escalation added this session (`getTestInventoryFileCount`, `TEST_MCP_INCREMENTAL_FULL_THRESHOLD`),
  `hasDynamicImportSyntax`'s existing detection logic (just no longer conditionally-skipped when a
  map is absent), `runOnce`'s pool-start-retry/heartbeat machinery (unrelated to coverage), the UI's
  render-reconciliation work from this session (unrelated subsystem).
- **Read before writing (per this skill's own mandate):** `src/worker/index.ts` in full (the
  single largest changed file — read Story 3.7's own file first for orientation, then the current
  state, since it has changed since), `src/selection/index.ts` in full, `src/orchestrator/index.ts`'s
  `resolveSelection`/`startRun`/`plan` methods, `src/coverage/index.ts` and `src/coverage/combined.ts`
  in full before deleting (confirm the dead-code inventory above is still accurate — it was
  compiled via a research pass this session, cite exact current line numbers in the PR, they will
  have drifted from the citations above).

## Review Findings (bmad-code-review, 2026-07-27)

Three adversarial layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor — implementer was
Sonnet, review ran on Opus, the recommended cross-model split). Every finding below was verified
against the current source, and the reachable ones were confirmed with live Vitest experiments
(deleted-path-in-`related`, deleted+modified-together, setup-file resolution). Severity is the
reviewer's final call, not the subagents' (they don't set it).

> **Resolution (2026-07-27):** decision resolved + all 8 patches applied and verified
> (typecheck/build clean, 291/291 tests pass). The `[ ]`→`[x]` marks below reflect that. The
> Decision was resolved by the user as "keep the heuristic as a rough guard, fix wording only" —
> the reason string and comment were already honest, so no code change was needed there.

### Decision-needed

- [x] [Review][Decision] **Size-based escalation now measures the wrong quantity.** RESOLVED: user
  chose to keep it as a rough speed guard (it's never a correctness mechanism); wording already
  accurate, no code change. **Size-based escalation now measures the wrong quantity.** `SelectionEngine.plan`
  (`src/selection/index.ts:130`) computes `fraction = changedFiles.length / totalTestFileCount` —
  raw changed-file count (sources + tests + config) over the *test-file* inventory. Pre-3.8 the
  numerator was `selected.size` (selected *test* files), which no longer exists at plan-time
  because `related` resolves inside Vitest in the worker. So the ratio is apples-to-oranges:
  8 source edits each hitting one shared test reads as high→escalate; one hub source fanning out
  to every test reads as low→don't. Disclosed as Completion-Note deviation #1, but the numerator
  is arguably meaningless now. It's a *speed heuristic*, never a correctness mechanism (escalating
  is always safe; not escalating just runs a normal incremental), so nothing is broken — but the
  feature no longer does what it says. Options: (a) drop the escalation entirely; (b) keep as a
  rough guard, fix the comment/reason wording only; (c) redesign to escalate in the worker once
  `related` has actually resolved N test files. Needs a human call.

### Patches (caused by this change; fixable without a decision)

- [x] [Review][Patch] **HIGH — stall watchdog can kill a large-project coverage run.** `runWithCoverage`
  (`src/worker/index.ts:673-740`) measures coverage in the same `runOnce` as results; after the
  last test module ends, Vitest still collects V8 coverage, remaps to istanbul, and writes
  `coverage-final.json` before `startVitest` resolves — with NO progress signal during that tail.
  The orchestrator watchdog (`src/orchestrator/index.ts:665-682`) rearms only on test-progress at
  `effectiveTestTimeoutMs + staleTestGraceMs` (default 5s+5s = 10s), so coverage generation that
  exceeds ~10s → worker killed mid-write. The deleted `withCoverageHeartbeat` (30-min floor)
  existed precisely for this window. This is the exact large-project+coverage scenario the epic
  was created to fix. Fix: re-introduce a keepalive/heartbeat around the coverage-enabled
  `runOnce` (or otherwise feed the watchdog during the coverage-generation tail).

- [x] [Review][Patch] **MEDIUM — a deletion + another change silently skips the deletion-broken test.**
  Confirmed live: `related = [deleted xsrc.ts, modified ysrc.ts]` selects ONLY `y.test.ts`;
  `x.test.ts` (imports the now-deleted file, therefore broken) is not selected, and because
  `y.test.ts` matched, `modules.length > 0` → returns "incremental" at HIGH confidence, no
  full-suite fallback. The old map path caught this via `map.map[deletedSrc].tests`. This is an
  invariant-5 regression (silently skipping a test a change broke). Fix: in `resolveSelection`/
  `SelectionEngine.plan`, detect changed paths that no longer exist on disk → escalate to full
  (safest), or at minimum flag `degraded`. Add a test for the deletion+change case.

- [x] [Review][Patch] **MEDIUM — watch mode runs coverage on an incremental run that resolves to full.**
  `coverage = opts.coverage ?? sel.strategy === "full"` (`src/orchestrator/index.ts:305`) turns
  coverage ON whenever a run resolves to full, and watch (`src/watch/index.ts:133`) calls
  `runTests({mode:"incremental"})` with no explicit coverage. A watch run that escalates (size)
  or falls back to full (non-git project → every watch run) then measures coverage — reintroducing
  the exact incremental-loop coverage cost AC7 forbids. Fix: watch passes `coverage: false`
  explicitly (a full-run opt-out is always allowed).

- [x] [Review][Patch] **MEDIUM-LOW — AC6 modified-source confidence gap.** `flaggedNewSources`
  (`src/selection/index.ts:153`) flags only NEW (added) sources `degraded`, never modified ones.
  A MODIFIED source reached by some test only via a dynamic `import()` is invisible to `related`'s
  static graph exactly as a new one is, but now reports HIGH confidence — presenting an incomplete
  run as trustworthy. Contradicts AC6's literal "NEW/modified source" text. Fix: flag modified
  sources under the same `mightMissDynamicImport` condition (or, if NEW-only is truly intended,
  renegotiate AC6 — but the code fix is safer and cheap).

- [x] [Review][Patch] **LOW — `related` `runOnce` lost its fall-back-to-full on throw.**
  (`src/worker/index.ts:525`) is not wrapped in try/catch; the old `--changed` branch was. Verified
  live that a deleted/non-existent path in `related` does NOT throw (resolves to zero → safe
  fallback), so the feared crash mode is largely inert — but any exotic internal Vitest error now
  propagates and fails the run instead of degrading to full (invariant 5). Cheap defensive wrap.

- [x] [Review][Patch] **LOW — `hasDynamicImportSyntax` runs on every incremental request.**
  `resolveSelection` calls it unconditionally (was `map ? … : false`), a project-wide `git grep`
  on the latency-sensitive incremental path, even for no-change / test-only runs where the result
  is discarded. Compute lazily, only when a source actually changed and there are added files.

- [x] [Review][Patch] **LOW — dryRun doesn't validate the coverage-on-incremental constraint.**
  `Orchestrator.plan` never throws `SelectionError`, so `dryRun:true, coverage:true` on an
  incremental selection previews success while the real run rejects with `ValidationError` — a
  planning/execution asymmetry. Mirror the check in `plan()`.

- [x] [Review][Patch] **LOW — Windows `isTestFile` regression.** The surviving copy
  (`src/selection/index.ts`, now also used by the worker's coverage report) splits on `"/"`; the
  deleted `src/coverage/index.ts` copy used `path.sep`. On Windows, `buildNativeCoverageReport`'s
  `path.relative` yields backslashes, so `__tests__` dirs are miscounted. Use a `[\\/]` split.

### Deferred / dismissed

- [x] [Review][Defer] Second double-pass in the explicit-files branch (`src/worker/index.ts:551-559`)
  — AC1 calls the zero-match fallback its "only" multi-pass scenario, but the explicit-files branch
  has an identical fallback. Pre-existing safety net (predates 3.8), not a regression; AC1 wording
  is over-strict. Deferred, no action.
- Dismissed as intended-design / doc-only: coverage rejected on explicit-file selections (per AC2);
  `fastMode` removal as a schema change (per AC7 — but warrants a CHANGELOG note); results now
  produced under V8 instrumentation (per AC1); corrupt-`coverage-final.json` degrading to no-coverage
  (intended "never crash," already logged); minor `thresholdsMet`/clamp doc-comment wording drift
  (folds into the Decision/HIGH patches if those land).

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via Claude Code.

### Debug Log References

- `pnpm run typecheck` — clean (0 errors) after all source changes.
- `pnpm run build` — clean; restarted this repo's own dev daemon as a side effect of `pnpm build`
  (its own `test-mcp restart` post-build step) — expected, not a regression.
- `pnpm test` — 48 test files / 284 tests, all passing (see Completion Notes for the real pass/fail
  transcript).
- Live end-to-end verification: a standalone script (`node`, run against a REAL isolated daemon —
  `TEST_MCP_HOME` override, never touching the real `~/.test-mcp/` — and a REAL git-initialized
  fixture project, over the actual `StreamableHTTPClientTransport`/HTTP MCP protocol, not an
  in-memory transport or a direct Orchestrator call) proved, in order: (1) editing `fileA.ts`
  uncommitted → incremental `run_tests` selects only `fileA.test.ts`; (2) ALSO editing `fileB.ts`
  with `fileA.ts`'s edit still uncommitted → a second incremental `run_tests` selects ONLY
  `fileB.test.ts`, never re-selecting `fileA.test.ts` (the exact `changed:true`-has-no-memory
  regression this story exists to prevent); (3) a full-suite `run_tests` with `coverage: true`
  returns a real coverage report (100% across all four metrics on the trivial fixture) from a
  single Vitest pass, and `coverage-map.json` is never written anywhere under the project's
  `.test-mcp/`; (4) an incremental `run_tests` with `coverage: true` is rejected over the real MCP
  tool-call boundary with `{ code: "ValidationError", message: "coverage is only available on a
  full-suite run (...)" }` — never silently downgraded. The script and its temp dirs were deleted
  after the run; nothing was left behind in the repo or in `~/.test-mcp/`.

### Completion Notes List

- **Task 1 (IPC):** `src/types/ipc.ts` — `ToWorker`'s `"run"` variant now carries
  `relatedFiles?: string[]` instead of `changed: boolean`; `allTestsRun` confirmed genuinely
  unused (grep: only ever written by the orchestrator, never read by the worker) and deleted.
  Removed the `"phase-progress"` `FromWorker` variant and `CoverageDelta` type/field entirely.
  Both Zod schemas updated to match.
- **Task 2 (Selection Engine):** `src/selection/index.ts` — `SelectionInput.map`/`strict` and the
  `CoverageMapFile` import are gone. `SelectionPlan` collapsed from a 3-way
  `full`/`changed-only`/`incremental` split to `full`/`incremental` only, with the incremental
  variant carrying `relatedFiles: string[]` instead of `testFiles`/`union`. No "full-suite
  trigger" concept survives (it was purely a map/setup-baseline artifact). Confidence logic:
  high by default; degraded ONLY for a NEW (untracked) source when `dynamicImportsPresent` —
  re-derived exactly per the story's Dev Notes guidance (a MODIFIED source has no analogous gap
  once there's no map to be "unmapped" against). The size-based full-run escalation (Task 3.4)
  now divides by the raw changed-file count, not a map-resolved test-file count, since plan()
  can no longer know the resolved test-file count ahead of Vitest's own `related` resolution —
  see the "Deviations" note below on what this costs in practice. `test/selection.test.ts`
  rewritten from scratch (30 tests, all passing).
- **Task 3 (Orchestrator):** `src/orchestrator/index.ts` — `resolveSelection` no longer loads a
  map; `hasDynamicImportSyntax` is now called unconditionally (was previously gated on a map
  existing). `startRun`'s coverage default is `opts.coverage ?? sel.strategy === "full"`
  (unconditional); a new `SelectionError` class (mirroring `WorkerError`/`PlanError`'s shape)
  is thrown when `opts.coverage === true && sel.strategy !== "full"`. `strict` removed from every
  option type/call chain (`runTests`, `startRun`, `plan`). Also removed the now-dead
  `TEST_MCP_MEASURE_BUDGET_MS` env-passthrough in the worker-fork setup (nothing reads it anymore
  once Task 4 deletes its only consumer) — a direct, in-scope cleanup, not a new feature.
- **Task 4 (Worker):** `src/worker/index.ts` — deleted `measureCoverage`, `measureSetupBaseline`,
  `buildAndPersistCoverageMap`, `buildNativeFullSuiteCoverage`, `persistAndCombine`, `withTimeout`,
  and the entire `withCoverageHeartbeat`/`COVERAGE_HEARTBEAT_*`/`NATIVE_COVERAGE_HEARTBEAT_FLOOR_MS`
  machinery. `runVitest` collapsed to two branches: `relatedFiles` (passed to Vitest as
  `{ related: absolutePaths }`, with the existing "matched nothing → fall back to full" safety
  net) OR explicit files/full suite (unchanged). The old "union" branch was confirmed unreachable
  (no code path populates both `files` and `relatedFiles` simultaneously — verified by reading the
  new `resolveSelection`/`ResolvedSelection` shape, not assumed) and deleted. Added
  `runWithCoverage`: the unified single-pass mechanism — merges `coverage.enabled:true` into the
  SAME `runOnce` call that produces real results, reads `coverage-final.json` afterward, and
  builds the report via the unchanged `buildNativeCoverageReport`. Logs at entry
  (`unified-coverage-start`) and at each silent-degrade branch (missing file, corrupt JSON) via
  the existing `logMemory` diagnostic. `handleRun` now calls exactly one of `runWithCoverage` or
  `runVitest` — never both, never a two-phase run.
- **Task 5 (Delete map modules):** `src/coverage/` deleted entirely (`index.ts` and
  `combined.ts`). `parseGlobalThresholds`/`meetsThresholds` relocated verbatim into
  `src/worker/index.ts` (their only remaining consumer). `isTestFile` calls in the worker now
  import from `src/selection/index.ts`'s existing independent copy. `TestResult["coverage"]`
  simplified in `src/types/contracts.ts`: `combined` and per-file `fresh`/`stale` removed;
  `buildNativeCoverageReport` updated to stop setting `fresh: true` (the field no longer exists).
- **Task 5b (Live-progress plumbing):** `LivePhase`, `LiveRunState.phase`, the `"phase-progress"`
  handler branch, and `getLiveRun`'s `phase` field removed from `src/orchestrator/index.ts`.
  `LiveView.phase`, its propagation in `uiSnapshot`, and `phaseProgressBlock` (+ its call site and
  now-dead `.phase-progress` CSS) removed from `src/ui/index.ts`. Done in the same pass as Task 1
  per the story's own warning, not as an afterthought — verified the build stayed green throughout
  by running `pnpm run typecheck`/`build` after Tasks 1-5b together, not at each intermediate step.
- **Task 6 (Watch mode):** `fastMode` removed from `WatchOptions`/`WatchStatus`/`Session`/`start()`
  in `src/watch/index.ts`; a watch-triggered run now omits `coverage` entirely (relying on the
  orchestrator's own default, which only turns on for a run that genuinely resolves to full — see
  the Deviations note on this specific behavior). `start_watch`'s `fastMode` param removed from
  `src/mcp/server.ts`.
- **Task 7 (MCP schema + docs):** `run_tests`'s `coverage` param description rewritten (no
  map-exists gate; full-suite-only; names the AC2 rejection). `strict` param removed. `docs/usage.md`
  ("Agent instructions", "Running tests", "Watch mode", state table) and `docs/architecture.md`
  (a new invariant 7, the component diagram/list, Data Model, MCP contracts, Execution Flows,
  Selection algorithm, Daemon↔Worker IPC, "Coverage Map Build" retitled to "(retired)", Open Risks)
  rewritten for the retired/unified design. `docs/prd.md` and `docs/patterns.md` annotated with
  dated "Superseded" blockquotes matching the existing Stories 3.2-3.7 convention (original
  rationale left untouched). `README.md`'s two current-tense factual claims (intro paragraph,
  "Coverage-aware" feature bullet) corrected directly, matching how prior stories have always
  touched this file (no blockquote-annotation convention exists there).
- **Task 8 (Tests):** Deleted `test/coverage-map.test.ts`, `test/coverage-unmeasurable.test.ts`,
  `test/coverage-build.test.ts`, `test/combined-coverage.test.ts` per 8.1. Rewrote
  `test/coverage-baseline.test.ts` (positive assertion of the setup-file `related` finding — see
  Deviations for the exact fixture shape that made this pass), `test/git-selection.test.ts`,
  `test/selection-integration.test.ts`, `test/orchestrator-selection-reason.test.ts`,
  `test/watch.test.ts` per 8.2. Adapted `test/worker-native-full-coverage.test.ts` per 8.3.
  `test/worker-coverage-heartbeat.test.ts` was DELETED rather than trimmed — see Deviations.
  Added the AC1/AC4 regression-proof tests inside the rewritten `test/git-selection.test.ts` and
  `test/selection-integration.test.ts` per 8.4 (both an orchestrator-level assertion AND the live
  end-to-end script above prove this). Added `test/coverage-full-suite-only.test.ts` per 8.5,
  covering the AC2 rejection at both the Orchestrator and MCP layers plus the "no lingering
  coverage state" case. Also updated (not listed in Task 8, but required for the build/tests to
  pass and directly caused by Tasks 1-5's removals): `test/worker-pool-retry.test.ts`,
  `test/worker-live-progress.test.ts`, `test/ipc-validation.test.ts`, `test/worker-run.test.ts`.

**Deviations from the story's stated approach (flagged per this repo's own precedent, not
silently patched around):**

1. **Size-based full-run escalation lost precision, not correctness.** Task 2.2/3.4 didn't
   fully anticipate that removing the map also removes the only thing that let `plan()` know a
   changed source's RESOLVED test-file count ahead of time. The escalation now divides by the
   raw changed-file count instead. Consequence, confirmed by a real Orchestrator-wired test
   (`test/selection-integration.test.ts`, "stays labeled incremental... even though the shared
   source resolves to every test"): editing ONE heavily-shared source file no longer preemptively
   escalates to "full" even when Vitest's own `related` graph will end up running the whole
   suite anyway — the run stays labeled "incremental" and still runs everything correctly (no
   correctness bug, invariant 5 intact), it just loses the OLD system's ability to see that
   coming and skip straight to "full" for the (now moot, since a single pass is a single pass
   either way) efficiency reason the escalation existed for. Flagging for review: is this an
   acceptable, expected consequence of retiring the map (my read), or does the escalation need a
   different heuristic (e.g. querying `related`'s own resolved count before deciding, which would
   reintroduce a form of two-phase resolution)?
2. **`test/worker-coverage-heartbeat.test.ts` deleted outright, not "renamed/trimmed" (Task 8.3).**
   Investigated first rather than assumed: EVERY test in this file exercised
   `buildAndPersistCoverageMap`'s heartbeat behavior specifically (Task 4.1 deletes that function
   entirely). The pool-start heartbeat Task 8.3 suggested "keeping" (`withPoolStartHeartbeat`,
   sending `"config"` messages) is a DIFFERENT mechanism than this file tested (it sends
   `"phase-progress"`), and is already fully covered by `test/worker-pool-retry.test.ts`
   (confirmed by reading that file). With the function under test gone, there was nothing left
   in this file to keep — trimming it to zero tests would be equivalent to deleting it, so I
   deleted it rather than leave an empty/near-empty file behind.
3. **A test-mcp-authored `SelectionError` was added to `orchestrator/index.ts`'s exports** (not
   explicitly listed as a File List touch anywhere in the story text beyond Task 3.2's body, but
   directly required by Task 3.2 and imported by `src/mcp/server.ts` and
   `test/coverage-full-suite-only.test.ts`) — noting it explicitly since it's a new exported
   symbol, not just an internal change.
4. **Watch mode's coverage omission (Task 6.1) can still measure coverage on rare escalated-to-
   full watch runs.** `WatchManager.runOnce` now omits `coverage` entirely (never passes `true`,
   satisfying AC7's literal wording and Task 6.1's "must never even attempt to pass coverage:
   true"), relying on the orchestrator's own AC3 default. If a watch-triggered incremental run
   happens to resolve to "full" (e.g. the size-based escalation, or a git-state edge case), that
   SPECIFIC run will now default coverage to `true` (per AC3's "unconditional" wording), unlike
   the old `fastMode: true` default which suppressed coverage even then. Read AC7 as being about
   removing the opt-in flag, not about forcing coverage off even on a genuine full-suite
   escalation; flagging in case review reads AC7 more strictly.
5. **`related`'s live-verified behavior is narrower than a first reading of the Dev Notes
   suggests.** The Dev Notes describe "a setup file... still correctly resolves as a dependency
   of every test that uses it" via `related: [setupFileAbs]`. My own live experiment (now
   `test/coverage-baseline.test.ts`) confirmed this EXACTLY as stated — but only when the changed
   file IS the setupFile itself. A first attempt at this test edited a file the setupFile itself
   imports (one level removed) and got a full-suite fallback instead (related matched zero test
   files for that file). This is NOT a correctness bug — the empty-match-falls-back-to-full safety
   net (AC1's sole exception) caught it correctly, exactly as designed — but it means `related`'s
   resolution does not appear to transitively walk what a setupFile itself imports, only the
   setupFile's own direct presence in the given file list. Flagging as a residual selection
   blind spot worth knowing about (added to `docs/architecture.md`'s Open Risks as item 5).
6. **`test/worker-run.test.ts`'s plain-run assertion updated for AC3.** Its existing "a plain run
   (no coverage requested) carries NO coverage report" test called `runTests` with zero options,
   which now measures coverage by default (AC3: full-suite coverage default is unconditional).
   Added an explicit `coverage: false` to keep testing what the test's own comment says it tests,
   rather than silently letting an unrelated default change flip its meaning.

**Not fully verifiable in this session:** watch mode's real filesystem-watcher path
(`test/watch.test.ts`) was exercised via its existing integration test (real fork, real Vitest,
polling for completion) and passed, but I did not additionally drive it through the real `/ui`
monitoring page in a browser (Playwright) — the `docs/architecture.md`/`src/ui/index.ts` changes
here are removals of dead UI (the coverage-phase progress bar), not new UI, so the main risk is
"does anything still reference the removed `phase` field and throw" — covered by
`pnpm run typecheck`/`build`/`test`, but a human eyeballing `/ui`'s live-run page once would still
be worthwhile since I did not do so via Playwright.

### File List

**Modified:**
- `src/types/ipc.ts`
- `src/types/contracts.ts`
- `src/selection/index.ts`
- `src/orchestrator/index.ts`
- `src/worker/index.ts`
- `src/watch/index.ts`
- `src/mcp/server.ts`
- `src/ui/index.ts`
- `docs/usage.md`
- `docs/architecture.md`
- `docs/prd.md`
- `docs/patterns.md`
- `README.md`
- `test/selection.test.ts` (full rewrite)
- `test/orchestrator-selection-reason.test.ts` (full rewrite)
- `test/git-selection.test.ts` (full rewrite)
- `test/selection-integration.test.ts` (full rewrite)
- `test/coverage-baseline.test.ts` (full rewrite)
- `test/worker-native-full-coverage.test.ts` (adapted)
- `test/watch.test.ts` (adapted)
- `test/worker-live-progress.test.ts` (adapted)
- `test/ipc-validation.test.ts` (adapted)
- `test/worker-pool-retry.test.ts` (adapted)
- `test/worker-run.test.ts` (adapted)

**Deleted:**
- `src/coverage/index.ts`
- `src/coverage/combined.ts`
- `test/coverage-map.test.ts`
- `test/coverage-unmeasurable.test.ts`
- `test/coverage-build.test.ts`
- `test/combined-coverage.test.ts`
- `test/worker-coverage-heartbeat.test.ts` (deviation — see Completion Notes)

**Added:**
- `test/coverage-full-suite-only.test.ts`
