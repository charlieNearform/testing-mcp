---
baseline_commit: 70f8be85711c44d8509e8ba4379d86e903267318
---

# Story 3.7: Native Full-Suite Coverage Pass

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an AI agent,
I want a full-suite, coverage-enabled `run_tests` to execute as one native Vitest coverage pass instead of one process per test file,
So that requesting coverage on a full run costs roughly a second `vitest run`, not the 6-8x overhead (and, on a real 286-file project, an outright daemon crash after 800+s) that per-file measurement costs at full-suite scale.

## Context (why this story exists, and why it does NOT do what Story 3.2 originally specified)

Story 3.2's AC1 mandated vendoring `testpick`'s (MIT) single-pass V8 snapshot-diff attribution
technique for building the reverse coverage map. It shipped instead with naive per-test-file
measurement as an "approved trade-off" (`deferred-work.md`), leaving single-pass snapshot-diffing
as `docs/architecture.md` Open Risk #1, "not yet implemented."

A real project confirmed this is not just a documentation gap: full-suite `run_tests` with
`coverage: true` took 800+s (vs ~100s without coverage) and eventually crashed the daemon
outright, with the coverage phase's own diagnostic logging showing it never got past its first
file. Naive per-file measurement runs Vitest **286 separate times** (once per test file) purely
to attribute coverage, on top of the one real run already done for test results.

**This story does not implement single-pass snapshot-diffing.** Investigation (including a
literal reverse-engineering attempt against `@vitest/coverage-v8`'s `V8CoverageProvider`, and
research into `testpick`'s actual technique) established that testpick's own algorithm is still
fundamentally per-file-attribution work, just batched into fewer serial processes (~1.8x
faster / ~4x less CPU than naive per-file, per its own published numbers) — it reduces the
per-file cost, it doesn't eliminate it. That's the wrong axis to optimize for the problem that
actually bit this project: **full-suite runs don't need per-file attribution at all.**

The reverse coverage map (source → which tests cover it) is a **soft, optional** signal for test
*selection* — confirmed in `src/selection/index.ts`: `SelectionEngine.plan` already falls back
gracefully to Vitest's static `--changed` import graph (`changed-only` strategy) whenever a
source is unmapped or the map doesn't exist at all, flagging `degraded` confidence rather than
failing. Attribution precision only matters for the **incremental/selective** path, where the
file count is small (a handful of touched files) and per-file measurement is cheap. A full-suite
run isn't selecting anything — it's the *gate* — so it only needs a whole-project coverage
**percentage report**, which is exactly what Vitest's own native `--coverage` flag already
produces in a single combined pass, with zero per-file attribution overhead.

So: full-suite + coverage becomes a single native Vitest pass (like a plain `vitest run
--coverage`); the reverse map is intentionally left un-refreshed by full-suite runs (an accepted,
already-safe tradeoff per the selection engine's existing degradation path); the existing
per-file measurement path is preserved unchanged for incremental/selective runs, where it belongs
and where it's cheap.

## Acceptance Criteria

1. **Given** a `run_tests` call reaches the worker with `files.length === 0` (this covers BOTH the
   true full-suite strategy AND the "changed-only" fallback strategy that also carries
   `files: []` — see Dev Notes on why both get identical treatment here) **and** coverage is
   requested, **when** the coverage phase runs, **then** it executes exactly ONE additional
   native Vitest pass over all discovered test files with `coverage.enabled: true` (mirroring
   `vitest run --coverage`) — not one process per test file. `buildCoverageMap` /
   `saveCoverageMap` (the reverse-map builder) is not invoked for this path, **regardless of
   whether a coverage map already exists for the project** — a virgin project's first full-suite
   coverage run does NOT fall back to the old per-file bootstrap; the reverse map is populated
   exclusively by the selective/incremental path (Task 2), by deliberate choice (see Dev Notes).

2. **Given** that native full-suite pass completes, **when** the run's `TestResult` is built,
   **then** `coverage` is populated directly from that single pass's own `coverage-final.json`:
   whole-project `total` + per-file percentages, `thresholds`/`thresholdsMet` asserted at
   `confidence: "high"`, every file `fresh: true` (no `stale`), and `combined` omitted/false — it
   is a fresh single measurement, not Story 6.10's union-of-historic-per-file-measurements case.

3. **Given** an incremental/selective run (`files.length > 0`) with coverage requested, **when**
   the coverage phase runs, **then** behavior is **unchanged**: the existing
   `buildCoverageMap` / `measureCoverage` / `persistAndCombine` per-file path still runs (cheap at
   this scale) and keeps the reverse map fresh for the touched files.

4. **Given** a project with a persisted coverage map, **when** a caller omits `coverage` on an
   **incremental/selective** run, **then** coverage defaults to `false` (the map-existing
   auto-default no longer applies to non-full runs — a caller must explicitly pass
   `coverage: true` to measure coverage on a selective run). **Given** the same omission on a
   **full-suite** run, **then** coverage still defaults to `true` when a map exists (unchanged).

5. **Given** the project's own `vitest.config` coverage settings (`include`/`exclude`/other
   provider options), **when** the native full-suite pass runs, **then** those settings are
   inherited exactly as `measureCoverage`'s existing per-file override already does today — only
   `enabled` / `provider` / `all: false` / `reporter` / `reportsDirectory` / `thresholds` are
   overridden by test-mcp, verbatim, matching `measureCoverage`. **Confirmed empirically during
   implementation:** the native pass's percentage denominator only covers files at least one test
   actually touched — the SAME scope the existing per-file and combined-report paths have always
   used (a source no test imports has never appeared in this tool's coverage %, anywhere). Making
   the native pass "more complete" than that (including never-imported dead code via
   `coverage.all: true`) would need an explicit `coverage.include` glob too — which means
   overriding the project's own include/exclude choice to get it — and would be a NEW, stricter
   guarantee this story was never asked to add. Consistency with the existing definition wins.

6. **Given** this story ships, **when** documentation is updated, **then**
   `docs/architecture.md`'s Open Risk #1 and `deferred-work.md`'s "single-pass V8 snapshot-diff
   measurement" + "vendoring testpick" entries are marked resolved/superseded (not "still
   deferred") — the gap they described is closed by this story's different mechanism, not by
   ever implementing single-pass snapshot-diffing.

## Tasks / Subtasks

- [x] Task 1: Native full-suite coverage pass (AC: 1, 2, 5)
  - [x] 1.1 In `buildAndPersistCoverageMap` (`src/worker/index.ts:766-899`), branch explicitly on
        `files.length === 0` — full-suite takes the new native-pass path; `files.length > 0`
        keeps today's per-file path completely unchanged (Task 2). **Deviation found during
        implementation (see Completion Notes):** `discoverTestFiles`/`createVitest` turned out to
        have NO remaining caller once the native pass doesn't need a pre-enumerated file list
        either (`startVitest("test", [], {...})` already means "run everything," same as the
        plain non-coverage full run) — both were deleted as dead code, along with the
        `createVitestOverride` param and its mismatch-guard block.
  - [x] 1.2 For the full-suite branch, call
        `startVitest("test", [], { watch: false, reporters: [{}], coverage: { enabled: true,
        provider: "v8", reporter: ["json"], reportsDirectory, thresholds: undefined } })` **once**
        — same call shape as `measureCoverage` (`src/worker/index.ts:669-682`). Passing `[]` as
        the file-filter array is this codebase's own established "run everything discovered" call
        — the exact same shape `runOnce` already uses for a full (non-coverage) run
        (`startVitest("test", filters, {...})` with `filters` = `[]`, see the call sites at
        `src/worker/index.ts:621,629,634`); no ambiguity here, don't re-derive the file list.
        **Keep `thresholds: undefined`** exactly like `measureCoverage` does (line 680) — do NOT
        pass the project's real thresholds into Vitest's own config. Passing real thresholds risks
        triggering Vitest's own threshold-enforcement/exit behavior in non-watch mode, which is an
        unverified and unnecessary way to reproduce the very crash this story fixes. Follow
        `measureCoverage`'s `mkdtempSync`/`try...finally rmSync` `reportsDirectory` pattern
        (lines 667, 700-702) exactly, and its graceful `if (!vitest) return {sources: [],
        measured: false}`-style degradation if Vitest returns falsy or the coverage file never
        materializes (e.g. no coverage provider installed) — never throw out of this path.
  - [x] 1.3 Read the resulting single `coverage-final.json` and convert it directly into
        `TestResult["coverage"]` (total + per-file percentages). Compute `thresholdsMet` the same
        way the existing combined-report path already does — via `meetsThresholds(total,
        thresholds)` (`src/coverage/combined.ts:89-90`, a pure percentage comparison, never
        Vitest's own gate) against the REAL `thresholds` param already passed into
        `buildAndPersistCoverageMap`. Do **not** call `buildCoverageMap`, `saveCoverageMap`, or
        `persistAndCombine` on this path.
  - [x] 1.4 Skip `measureSetupBaseline` for this path — setup-baseline subtraction (Story 3.3)
        exists to correct **per-test attribution**; a native combined pass has no per-test
        attribution to correct, and does not affect the raw coverage percentages either way.
        **Update the mismatch guard at `src/worker/index.ts:781-794`**: its comment currently
        asserts "measureSetupBaseline (below) always runs and always needs startVitest,
        regardless of `files`" — that invariant becomes false once the full-suite branch skips
        it. Rewrite the guard so it still throws on a genuine override mismatch for whichever
        paths (selective, and now the native full-suite pass) actually call `startVitest`, without
        relying on the now-incorrect "baseline always runs" premise.
  - [x] 1.5 Keep the existing `withCoverageHeartbeat` stall-safety wrapping this call (it's now
        one long silent operation instead of many shorter ones — exactly the shape the heartbeat
        exists to protect). Decide how `phase-progress` reports during this single pass (no
        natural "file N of M" count anymore) — e.g. an indeterminate/spinner-style signal instead
        of a counter is acceptable; note the choice in Completion Notes for the UI's
        `phaseProgressBlock` (`src/ui/index.ts`) to render sensibly (it already handles
        `total === 0` as "starting…" — confirm that reads acceptably for this case, or adjust).
- [x] Task 2: Confirm selective/incremental path is untouched (AC: 3)
  - [x] 2.1 `files.length > 0` continues through the existing `buildCoverageMap` /
        `measureCoverage` / `persistAndCombine` path with zero changes. Do not touch
        `src/coverage/index.ts` or `src/coverage/combined.ts` at all.
- [x] Task 3: Scope the coverage-map-exists auto-default to full-suite runs only (AC: 4)
  - [x] 3.1 In `src/orchestrator/index.ts:287-288`, `sel` (the resolved selection) is already
        computed before the coverage default line. Change
        `const coverage = opts.coverage ?? loadCoverageMap(project.path) !== null;` to gate the
        map-exists auto-default on `sel.strategy === "full"`; any other resolved strategy
        defaults to `false` when `coverage` is omitted.
  - [x] 3.2 Update the docstring at `src/orchestrator/index.ts:251-256` and the `coverage` param
        docstring in `src/mcp/server.ts` (~line 152-159) to describe the narrower default
        accurately.
- [x] Task 4: Contract doc comment (AC: 2)
  - [x] 4.1 Update the doc comment on `TestResult["coverage"]` (`src/types/contracts.ts:53-61`) to
        describe both cases that now populate this field: the native full-suite single pass (this
        story — always fresh, no `combined`) and Story 6.10's incremental union-of-per-file-latest
        case (`combined: true`). No schema/shape change.
- [x] Task 5: Documentation (AC: 6)
  - [x] 5.1 Update `docs/architecture.md`'s "Coverage Map Build" section (lines ~299-324) and
        "Open Risks" item 1 (lines ~348-352): full-suite coverage now uses Vitest's native
        combined pass; the reverse map is deliberately not refreshed by full-suite runs, relying
        on `src/selection/index.ts`'s existing graceful degradation to the static graph for
        sources the map doesn't know about. Do not edit `docs/coverage-spike-findings.md` — it's
        a dated spike record; leave it as historical evidence for *why* naive per-file-at-scale
        was the problem.
  - [x] 5.2 Update `deferred-work.md`'s "Single-pass V8 snapshot-diff measurement" and "Vendoring
        `testpick`" entries: mark both permanently superseded by this story (the gap is closed by
        a different mechanism, not by ever building what they described).
- [x] Task 6: Tests
  - [x] 6.1 Worker-level test: full-suite + `coverage: true` against a small real fixture —
        assert exactly one `startVitest` coverage call happens (not one per file), and
        `TestResult.coverage` is populated with real numbers and `thresholdsMet` evaluated.
  - [x] 6.2 Assert the on-disk reverse coverage map is byte-for-byte unchanged after a full-suite
        coverage run, when a map already existed beforehand.
  - [x] 6.3 Orchestrator-level test: incremental/selective run with an existing map and
        `coverage` omitted resolves to `coverage: false`; full run with an existing map and
        `coverage` omitted still resolves to `coverage: true` (existing behavior preserved for
        that case) — cover both branches of the `sel.strategy === "full"` gate added in Task 3.
  - [x] 6.4 Regression: run the existing coverage-map build/persist, setup-baseline subtraction,
        and always-run-unmeasurable-tests test suites unmodified — this story must not change
        their behavior.
  - [x] 6.5 Assert `thresholdsMet` for the native-pass path is computed via `meetsThresholds()`
        against real percentages (not by relying on Vitest's own threshold gate) — e.g. a fixture
        configured with a threshold the actual run fails should report `thresholdsMet: false`
        without the worker throwing/exiting.
  - [x] 6.6 Confirm a virgin project (no coverage map on disk) that runs full-suite +
        `coverage: true` gets a populated `TestResult.coverage` report but creates NO coverage-map
        file on disk (Task 1's confirmed "never bootstrap from full runs" decision).
  - [x] 6.7 Confirm a changed-only run (no map, or unmapped source) with `coverage` explicitly
        forced to `true` also takes the native-pass path (one `startVitest` call, not per-file
        discovery-and-measure) — covering the edge case in Dev Notes where `files.length === 0`
        represents "changed-only" rather than true full-suite.

### Review Findings

Adversarial review (Blind Hunter, Edge Case Hunter, Acceptance Auditor — 3 independent
subagents, no shared context) against the full diff since `baseline_commit`. All `patch`
findings below were applied and verified (`pnpm run typecheck`/`build`/`test` all green,
318/318) before this section was written, given the low ambiguity of each fix.

**Patch (applied):**

- [x] [Review][Patch] Misleading control-flow comment said `handleRun` routes the full-suite branch, when `buildAndPersistCoverageMap` itself does [src/worker/index.ts:761]
- [x] [Review][Patch] MCP tool `coverage` param description omitted the changed-only-with-no-map carve-out (same native-pass treatment as full-suite) [src/mcp/server.ts:156-163]
- [x] [Review][Patch] Clarified `provider: "v8"` is forced (matching `measureCoverage`'s existing precedent), not a new deviation from "inherit project config" (AC5) [src/worker/index.ts:919-922]
- [x] [Review][Patch] Test title overclaimed coverage of the empty-files branch it didn't exercise [test/worker-coverage-heartbeat.test.ts:193]
- [x] [Review][Patch] `docs/architecture.md` Open Risk #1 said "Resolved" unscoped; the incremental/selective path's per-file mechanism is unchanged and could still hit the same cost class at large file counts — tightened to scope the claim to full-suite [docs/architecture.md:363-372]
- [x] [Review][Patch] `TEST_MCP_FULL_COVERAGE_BUDGET_MS` parsed via bare `Number(...)`; a non-numeric env value produces `NaN`, and `Math.max(floor, NaN)` is `NaN` — silently disables the heartbeat cap forever instead of falling back to the floor [src/worker/index.ts:905-910]
- [x] [Review][Patch] Unguarded `JSON.parse` on the native pass's `coverage-final.json` — a truncated/corrupt file (disk full, killed mid-write) threw instead of degrading gracefully like the adjacent `!fs.existsSync` branch [src/worker/index.ts:949-956]
- [x] [Review][Patch] Task 6.2 ("map byte-for-byte unchanged when one already existed") was marked complete but no test asserted it — added one [test/worker-native-full-coverage.test.ts]
- [x] [Review][Patch] Task 6.1/6.7 ("exactly one `startVitest` call") was marked complete but inferred from output shape, never literally counted — added a call-counting test [test/worker-coverage-heartbeat.test.ts]
- [x] [Review][Patch] New operator-facing surface (`TEST_MCP_FULL_COVERAGE_BUDGET_MS`, `NATIVE_COVERAGE_HEARTBEAT_FLOOR_MS`) wasn't disclosed in Completion Notes despite the story's own pattern of disclosing every other deviation — added

**Defer (pre-existing, out of this story's scope):**

- [x] [Review][Defer] The untouched per-file path (`measureCoverage`/`TEST_MCP_MEASURE_BUDGET_MS`) has the identical `NaN`-poisoning and unguarded-`JSON.parse` gaps just fixed in the new native-pass code [src/worker/index.ts] — deferred, pre-existing; recorded in `deferred-work.md`.

**Dismissed as noise/false-positive/already-handled (10):** two reviewers independently
confirmed the `files.length === 0` full-vs-changed-only dual-signal is deliberate and already
disclosed/tested (Dev Notes + Task 6.7), not an oversight; the "silently disappears on timeout"
and "disabling Vitest's threshold gate" findings both matched pre-existing, already-shipped
behavior (not a new deviation this story introduced); `pct()`'s zero-coercion and the untyped
`reporters: [{}]` both copy an existing, already-typechecked pattern from `measureCoverage`;
the dead-code-deletion-safety concern was already verified via `grep` + a full green test suite;
the UI wording nitpick was a defensible either-way call; the process-compliance note was a false
positive (this story WAS created via `bmad-create-story` before implementation, not as-built).
One Acceptance-Auditor finding (`CHANGELOG.md`/`docs/prd.md`/`docs/usage.md` "undisclosed"
changes) was a timing artifact, not a scope violation: those are a separate, explicitly
user-requested documentation-sync pass made concurrently with this review, not part of this
story's own File List.

## Dev Notes

- **Core seam**: `buildAndPersistCoverageMap` (`src/worker/index.ts:766-899`) already forks on
  `files.length` at lines 809-812 for discovery vs. explicit selection — that's the correct
  insertion point. Do not add new coverage branching in `handleRun` itself.
- **Reuse, don't reinvent, the per-file call shape**: `measureCoverage`
  (`src/worker/index.ts:662-703`) already proves that a partial `coverage` config passed to
  `startVitest` overlays correctly onto the project's own resolved `vitest.config` (provider,
  reporters, `reportsDirectory` override without clobbering `include`/`exclude`/`all`). Reuse
  that exact pattern for the native full pass verbatim, including `thresholds: undefined` — the
  ONLY difference is the file-filter array (whole discovered set / `[]`, not one file). Do not
  pass real thresholds into Vitest's own config (see Task 1.2/1.3) — compute `thresholdsMet`
  yourself via `meetsThresholds()` instead.
- **Do not touch** `src/coverage/index.ts` (`buildCoverageMap`, `addEdges`, `pruneTests`,
  `extractCoveredSources`, schema versioning) or `src/coverage/combined.ts` (`persistAndCombine`'s
  union/staleness logic) — both are exclusively the selective/incremental path's machinery now,
  and remain byte-for-byte as-is.
- **`allTestsRun` is already threaded over IPC but unused**: `src/orchestrator/index.ts:740` sets
  `allTestsRun: files.length === 0` on the `ToWorker` "run" message
  (`src/types/ipc.ts:14,102`), but nothing in `src/worker/index.ts` currently reads
  `msg.allTestsRun`. It's equivalent to re-deriving `files.length === 0` inside
  `buildAndPersistCoverageMap` (which is what the existing discovery fork already does) — use
  whichever is more direct at the call site; there's no functional difference, just note in
  Completion Notes which was used so it isn't rediscovered as "dead code" later.
- **Selection safety net that makes this tradeoff acceptable**: `SelectionEngine.plan`
  (`src/selection/index.ts`) treats a missing/stale coverage-map entry as a soft signal — falls
  back to the static `--changed` import graph (`changed-only` strategy), flags `degraded`
  confidence, never fails or silently under-selects. Full-suite runs no longer refreshing the map
  means files *only* ever exercised by full-suite runs stay permanently "unknown to the map" and
  rely on the static-graph fallback — which is the same conservative behavior an unmapped file
  already gets today. This is not a regression in correctness, only a ceiling on selection
  *precision* for that subset of files. Confirmed via `test/selection.test.ts` /
  `test/selection-integration.test.ts` that this fallback path is already exercised and expected.
- **Confirmed product decision: the reverse map never bootstraps from full-suite runs, even on a
  virgin project with no map yet.** A project whose only usage pattern is "fast iterative runs
  with `coverage: false` + occasional full-suite runs as a gate" will, by design, never build a
  coverage map at all — selection for such a project runs on the static import graph alone,
  permanently. This was confirmed explicitly (not assumed) because it's a real fork in Epic 3's
  value proposition for that usage pattern: the map is optional precision on top of a baseline
  (static graph) that always works alone, so this is an accepted tradeoff, not a silent
  regression. Do not add any "first run bootstraps the map via the slow path" special case —
  it was considered and explicitly rejected.
- **The `files.length === 0` branch condition covers TWO distinct resolved strategies, and both
  get identical (native-pass) treatment, deliberately**: `resolveSelection`
  (`src/orchestrator/index.ts`) returns `files: []` for both the true full-suite strategy AND the
  "changed-only" fallback (`strategy: "incremental", files: [], changed: true` — no map yet, or an
  unmapped source; see `src/orchestrator/index.ts:476-479`). The worker only sees `msg.files`,
  `msg.changed`, and `msg.allTestsRun` over IPC (`src/types/ipc.ts:14,102`) — `msg.files.length ===
  0` alone does not distinguish these two cases from each other. Task 3's coverage-default gate
  (AC4) already suppresses coverage-by-default for the changed-only case (its resolved strategy is
  `"incremental"`, not `"full"`), so this branch is normally only reached by a genuine full-suite
  run. If a caller EXPLICITLY forces `coverage: true` on a changed-only run, `buildAndPersistCoverageMap`
  still receives `files: []` and takes the same native-pass path — this is a **strict improvement**
  over today's behavior, not a new gap: today, `files.length === 0` unconditionally triggers
  `discoverTestFiles` and per-file measurement of the ENTIRE project regardless of whether the
  triggering strategy was "full" or "changed-only" (`src/worker/index.ts:809-812` forks purely on
  `files.length`, with no `changed` check at all) — so changed-only-with-forced-coverage already
  pays the full 286-file per-file cost today. Routing it through the cheap native pass instead is
  strictly better, never worse.
- **Why not testpick after all**: researched testpick's actual technique (it's plain Node, MIT,
  no runtime deps) — it shards test files across cores and runs each shard as one serial Vitest
  process, snapshotting cumulative V8 coverage after each file and diffing consecutive snapshots
  for attribution. That is the same per-file-attribution work Story 3.2's original AC specified,
  just batched more efficiently (~1.8x faster / ~4x less CPU than naive-per-file, per its own
  numbers) — it does not remove per-file measurement, it optimizes it. This story sidesteps that
  entire cost for the full-suite case instead of optimizing it, which is strictly cheaper for the
  problem that was actually reported (the crash/800s), and requires zero new dependency or
  vendored code.
- **Historical spike numbers for context** (`docs/coverage-spike-findings.md`, unchanged/do not
  edit): on the real target project, a native combined run measured ~13.0s for 22 files vs. ~77.4s
  for the same 22 via naive per-file — this story adopts the ~13s side of that comparison for the
  full-suite+coverage case, at whole-project scale (286 files on that project), instead of
  attempting the harder ~1.8x-faster testpick-style middle ground.
- **`withCoverageHeartbeat` (Story 8.2/AD-20) still applies**: the native pass is one long-running
  silent Vitest invocation — exactly what the heartbeat/stall-watchdog machinery exists to guard.
  Do not remove it from this path.

### Project Structure Notes

- Files touched: `src/worker/index.ts` (coverage-phase branch), `src/orchestrator/index.ts`
  (coverage default gating), `src/mcp/server.ts` (docstring only), `src/types/contracts.ts` (doc
  comment only), `docs/architecture.md`, `_bmad-output/implementation-artifacts/deferred-work.md`.
- No new files. No new dependencies — `startVitest` is already imported/resolved via the existing
  `createRequire(...)("vitest/node")` pattern at `src/worker/index.ts:795-798`.
- `src/ui/index.ts`'s `phaseProgressBlock` (added this session for the coverage phase-progress
  indicator) may need its "starting…" / indeterminate rendering revisited for a full-suite pass
  that no longer reports a file counter — see Task 1.5.

### References

- [Source: src/worker/index.ts#L766-L899] `buildAndPersistCoverageMap` — insertion point.
- [Source: src/worker/index.ts#L662-L703] `measureCoverage` — call-shape pattern to reuse.
- [Source: src/orchestrator/index.ts#L245-L291] `runTests`/`startRun` — coverage default site.
- [Source: src/selection/index.ts] `SelectionEngine.plan` — graceful map-absence fallback that
  makes this story's tradeoff safe.
- [Source: src/types/ipc.ts#L14,#L102] `allTestsRun` on the `ToWorker` "run" message.
- [Source: src/types/contracts.ts#L53-L79] `TestResult["coverage"]` shape.
- [Source: docs/architecture.md#Coverage-Map-Build] Open Risk #1, "mandatory refinements."
- [Source: docs/coverage-spike-findings.md] native-combined vs. naive-per-file spike numbers.
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] single-pass/testpick entries
  to be marked superseded.
- [Source: _bmad-output/implementation-artifacts/story-3-2-coverage-reverse-map-build-persist.md]
  original AC1/AC2 and the "approved trade-off" this story supersedes.

## Dev Agent Record

### Agent Model Used

claude-sonnet-5

### Debug Log References

- `pnpm run typecheck` — exit 0
- `pnpm run build` — exit 0 (tsc compile clean; daemon restart side-effect from the repo's own `build` script, unrelated to this story)
- `pnpm test` — 52 files / 316 tests passed, 0 failed (full suite, no regressions)

### Completion Notes List

- **Task 1 deviation (found during implementation, not anticipated in Dev Notes):** `discoverTestFiles` and the `createVitest`/`createVitestOverride` machinery in `buildAndPersistCoverageMap` had no remaining caller once the full-suite branch stopped needing a pre-enumerated file list (`startVitest("test", [], {...})` already means "run everything," identical to the plain non-coverage full run's own call shape). Deleted as dead code: `discoverTestFiles` function, `createVitestOverride` param, and its mismatch-guard block (the guard's own "measureSetupBaseline always runs" premise would otherwise have gone stale/incorrect once the full-suite branch skips it). This also fully resolves Task 1.4's originally-scoped "update the guard comment" item — there is no longer a guard to update.
- **New operator-facing surface not anticipated by Task 1.5's original text:** `buildNativeFullSuiteCoverage` needed its own heartbeat ceiling, separate from the existing per-file `TEST_MCP_MEASURE_BUDGET_MS`-derived one — that value is calibrated for a single file's ~120s budget and would cut heartbeats off long before a real multi-minute full-suite pass finishes. Added `TEST_MCP_FULL_COVERAGE_BUDGET_MS` (operator-configurable) with a `NATIVE_COVERAGE_HEARTBEAT_FLOOR_MS` (30-minute) floor, mirroring the existing env-var/floor pattern. Guarded against a non-numeric/empty env value producing `NaN` (which would silently disable the cap forever via `Math.max(floor, NaN) === NaN`) — found via adversarial review, not anticipated originally. Covered by 2 new tests in `test/worker-coverage-heartbeat.test.ts`.
- **Adversarial review (code-review pass) found and fixed two real gaps beyond the above:** (1) a truncated/corrupt `coverage-final.json` (disk full, killed mid-write — exactly the failure class this story exists to survive) previously threw an unguarded `JSON.parse` out of the coverage phase instead of degrading gracefully like the adjacent `!fs.existsSync` check already does; wrapped in try/catch. (2) Two ACs (Task 6.2 "map byte-for-byte unchanged," Task 6.1/6.7 "exactly one `startVitest` call") were marked complete based on tests that verified the *outcome* (map absent, report shape) but never literally asserted the specific claim in the task text — added a call-counting test and a before/after byte-comparison test for the pre-existing-map case to close that gap.
- **Noted for the ledger, not fixed (pre-existing, out of this story's scope):** the same `Number(envVar) → NaN → Math.max poisoning` pattern and an unguarded `JSON.parse(coverage-final.json)` already exist in the untouched per-file path (`TEST_MCP_MEASURE_BUDGET_MS`'s `budgetMs`, and `measureCoverage`'s own JSON.parse) — found while fixing the equivalent code in the new native-pass path. Left as-is per scope discipline (a different, untouched code path); recorded in `deferred-work.md`.
- **AC5 corrected during implementation (empirically verified, not assumed):** initially attempted `coverage.all: true` so a never-imported source would still count (at 0%) toward the whole-project denominator. Verified via a direct Vitest CLI probe (`vitest run --coverage --coverage.all=true`, real fixture) that the v8 provider does NOT include such files without ALSO passing an explicit `coverage.include` glob — which would mean overriding the project's own include/exclude choice. Reverted to `all: false` (verbatim match with the existing `measureCoverage` per-file override) — the native pass's percentage denominator is scoped identically to every other coverage % this codebase has ever reported (touched-files-only); pursuing "whole-project including untouched files" would have been a new, stricter guarantee never asked for. AC5 text updated in place to record this.
- **Regression surgery required beyond Task 6's original scope:** confirmed AC1's "full-suite runs never build the map, even on a virgin project" decision (agreed with the user before implementation) broke the *bootstrap* step of several pre-existing tests that used an implicit full-suite `{coverage: true}` call to seed a coverage map before testing incremental/selective behavior on top of it: `test/coverage-build.test.ts`, `test/coverage-baseline.test.ts`, `test/coverage-unmeasurable.test.ts`, `test/selection-integration.test.ts`, `test/watch.test.ts`. Fixed each bootstrap call site to use an explicit `files: [...]` list (the only path that still builds the map), and split/rewrote the `coverage-build.test.ts` tests whose core assertion was specifically "a full run builds the map" (no longer true) into a full-suite variant (asserts a native report + no map) and an explicit-files variant (asserts the map still builds, unchanged). `test/worker-coverage-heartbeat.test.ts` was rewritten to drop tests for the now-deleted discovery/mismatch-guard behavior and add equivalent heartbeat coverage for the native pass's own (30-minute-floor) heartbeat ceiling. Added `test/worker-native-full-coverage.test.ts` for the native pass's own correctness (percentages, manual `thresholdsMet`, no map written, changed-only-with-forced-coverage takes the same path).
- All 6 acceptance criteria verified: AC1/AC2/AC5 via `test/worker-native-full-coverage.test.ts`; AC3 via the unchanged assertions in the explicit-files tests across `coverage-build.test.ts`/`coverage-baseline.test.ts`/`coverage-unmeasurable.test.ts`; AC4 via the two split tests in `coverage-build.test.ts`'s "coverage default" describe block; AC6 via the `docs/architecture.md` and `deferred-work.md` edits (Task 5).

### File List

- `src/worker/index.ts` — modified (removed `discoverTestFiles`/`createVitestOverride`; added `buildNativeFullSuiteCoverage`, `buildNativeCoverageReport`, `pct`, `NATIVE_COVERAGE_HEARTBEAT_FLOOR_MS`; rewrote `buildAndPersistCoverageMap`'s doc comment and full-suite branch)
- `src/orchestrator/index.ts` — modified (`startRun`'s coverage default now gates the map-exists auto-default on `sel.strategy === "full"`; updated `runTests`'s `coverage` option docstring)
- `src/mcp/server.ts` — modified (`coverage` tool-input param docstring updated to describe the narrower incremental/selective default)
- `src/types/contracts.ts` — modified (`TestResult["coverage"]` doc comment describes both the native full-suite path and the Story 6.10 combined-union path)
- `src/ui/index.ts` — modified (`phaseProgressBlock`'s indeterminate label changed from "starting…" to "in progress…", since the native pass can hold that state for minutes, not just a brief discovery window)
- `docs/architecture.md` — modified ("Coverage Map Build" implementation note + refinement #2 rewritten; Open Risk #1 marked resolved)
- `_bmad-output/implementation-artifacts/deferred-work.md` — modified (single-pass/testpick entries marked superseded/resolved; full-rebuild-pruning entry's scope note added)
- `test/worker-coverage-heartbeat.test.ts` — modified (removed 3 tests for deleted discovery/mismatch-guard behavior; added a new "native full-suite coverage pass heartbeats" describe block, 4 tests including a call-count assertion added during code review)
- `test/worker-native-full-coverage.test.ts` — new (4 tests: native-pass percentages/no-map, manual thresholdsMet, changed-only-forced-coverage takes the native path, byte-for-byte-unchanged map added during code review)
- `test/coverage-build.test.ts` — modified (split the full-run map-building test into a full-suite variant + an explicit-files variant; fixed 4 other bootstrap call sites to use explicit `files`; split the "coverage default" test into full-suite vs. incremental/selective variants)
- `test/coverage-baseline.test.ts` — modified (bootstrap call site uses explicit `files`)
- `test/coverage-unmeasurable.test.ts` — modified (bootstrap call site uses explicit `files`)
- `test/selection-integration.test.ts` — modified (bootstrap call site uses explicit `files`)
- `test/watch.test.ts` — modified (bootstrap call site uses explicit `files`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — modified (story status tracking)
- `_bmad-output/planning-artifacts/epics.md` — modified (Story 3.7 entry added during story creation, prior to this implementation session)
