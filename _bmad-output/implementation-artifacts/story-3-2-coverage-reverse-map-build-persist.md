# Story 3.2: Coverage Reverse-Map Build & Persist

Status: done

> **Implemented by the orchestrator (not the local model), by explicit decision.** This is the
> spike-flagged core differentiator. The architecture's mandated *single-pass V8 snapshot-diff /
> testpick-vendored* mechanism is research-heavy (testpick source is not in the repo). Per approved
> trade-off, this story ships the **spike-proven per-test-file measurement** (identical map accuracy),
> and defers single-pass + testpick licensing to the ledger.

## Story

As an AI agent,
I want a persisted source→test reverse map,
so that a source edit resolves to the tests that exercise it.

## Acceptance Criteria

1. **Build & persist from V8 coverage.** A coverage run (`run_tests({ coverage: true })`) builds a
   source-file → test-file reverse map from runtime V8 coverage and persists it keyed by `projectId`,
   surviving daemon restarts. ✅ (per-test-file measurement; see trade-off below)
2. **License retention for vendored `testpick`.** N/A — no testpick code is vendored in this
   implementation. Deferred with the single-pass optimisation. (deferred-work.md)
3. **Incremental update.** When a map exists and specific test files changed, only those files are
   re-measured and the map is updated incrementally (other edges preserved). ✅

## What shipped

- **`src/coverage/index.ts`** — the Coverage Engine (Vitest-free, unit-testable):
  - `CoverageMapFile` (`schemaVersion`, `projectId`, `updatedAt`, `map: source→{ tests[], lastMeasured }`).
  - `coverageMapPath` / `loadCoverageMap` / `saveCoverageMap` — persisted at
    `<projectRoot>/.test-mcp/coverage-map.json` (write-temp-then-rename; schema-version guarded).
  - `buildCoverageMap({ projectRoot, projectId, targetTestFiles, existing, measure })` — full build
    (existing=null) or incremental (prunes edges for the target test files, re-measures only those,
    preserves the rest). Records `unmeasuredTestFiles` (no silent success — precursor to Story 3.4).
  - `extractCoveredSources(coverageFinal, projectRoot, measuredTestAbs)` — turns a V8
    `coverage-final.json` into in-tree, non-test source files with ≥1 executed statement.
- **`src/worker/index.ts`** — when the run message has `coverage: true`, after the normal run the
  worker measures each target test file (`startVitest([file], { coverage: v8, all:false, reporter:["json"] })`),
  reads `coverage-final.json`, builds/updates the map, and persists it. Discovers all test files via
  `createVitest(...).globTestSpecifications()` for a full build; uses the explicit `files` list for
  incremental. Returns a `coverageDelta` summary over IPC.
- **`src/types/ipc.ts`** — `ToWorker` run message gains `projectId` (so the persisted map is keyed by it).
- **`src/orchestrator/index.ts`** — `runTests(project, { coverage })` threads the flag and `projectId`
  into the run message.
- **`src/mcp/server.ts`** — `run_tests` gains a `coverage?: boolean` input, forwarded to the orchestrator.
- **Dependency:** added `@vitest/coverage-v8@4.1.9` (devDependency; projects supply their own at runtime).

## Trade-off (approved) & deferred work

- Per-test-file measurement instead of single-pass snapshot-diff — correctness identical, ~6× cost on
  large suites (spike figure). Single-pass + `testpick` vendoring (and its MIT NOTICE/header, AC2) are
  in `deferred-work.md`.

## Tests

- `test/coverage-map.test.ts` — pure unit tests: full build, incremental (edge pruning + preservation),
  unmeasured-file recording, `extractCoveredSources` filtering.
- `test/coverage-build.test.ts` — integration through the real `Orchestrator` + built worker against a
  temp project (Vitest + coverage-v8 resolved via a `node_modules` symlink; `realpath` so V8 absolute
  paths match the project root on macOS): full build produces `math.ts→[math.test.ts]`,
  `other.ts→[other.test.ts]`, persisted to disk; incremental re-measure of one file preserves the other's edges.

## Dev Agent Record

### Agent Model Used
Orchestrator (Opus) — implemented directly per user decision (option: orchestrator implements now, defer single-pass).

### Completion Notes
- `pnpm run typecheck`, `pnpm run build`, `pnpm test` all green (18 files / 65 tests).
- Map persisted per project under `.test-mcp/coverage-map.json`; survives restarts (plain JSON on disk).

### File List
- src/coverage/index.ts (new)
- src/worker/index.ts
- src/types/ipc.ts
- src/orchestrator/index.ts
- src/mcp/server.ts
- test/coverage-map.test.ts (new)
- test/coverage-build.test.ts (new)
- package.json / pnpm-lock.yaml (@vitest/coverage-v8 devDependency)
