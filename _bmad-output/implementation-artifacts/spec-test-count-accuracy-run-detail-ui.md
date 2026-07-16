---
title: 'Accurate test-count reporting and reorganized run-detail UI'
type: 'bugfix'
created: '2026-07-16'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'b51de77127caff2dacf354612acc6725bd3763b8'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The monitoring UI's pass/total ratio silently folds skipped tests into the denominator, so a run with skips still reads as a clean green "X/Y passed" with no visibility into the skip. Separately, the "total tests" figure is just the union of (file, test-name) pairs across the capped 50-run history ring buffer (in-memory and on-disk), so it shrinks/drifts as older runs age out instead of reflecting the project's true, current unique-test count — exactly the 1529 vs 2681 vs 4923 mismatch reported against a real project.

**Approach:** Show skipped counts separately and exclude them from the pass/fail/total ratio everywhere it's rendered (UI + the worker's one-line summary text). Replace the history-union total with a small persisted per-project test inventory (file → test names), reconciled from each run's already-computed `tests` list keyed off `result.selection.files` (the files actually executed) so it self-heals additions and deletions without depending on retained history depth. Also reorder the run-detail view so failures render first, with the Selection and Tests sections collapsed by default.

## Boundaries & Constraints

**Always:**
- `TestResult.total/passed/failed/skipped` and their existing meaning stay untouched — only display/summary text and a new project-local cache change.
- Inventory reconciliation is per-file: for every file in `result.selection.files`, replace that file's cached test-name set with the names seen in this run's `tests` for that file; untouched files keep their prior cached entries. This applies uniformly to full and incremental runs (no branching on `strategy`).
- Skip reconciliation entirely for a run whose `testsTruncated` is true — never delete based on an incomplete list (over-count is the safe direction, matching the Selection Engine's existing degraded-confidence bias).
- Inventory persistence is best-effort (atomic temp+rename, schemaVersioned) under `.test-mcp/test-inventory.json`; a read/write failure logs to stderr and never fails a run or crashes the daemon (mirror `src/history/index.ts`'s existing pattern).
- Failures render first in the run-detail view, immediately after the status grid; Selection and Tests become collapsed-by-default `<details>` sections; Confidence/Coverage keep their current position (between failures and Selection).

**Never:**
- Do not change the wire meaning of `TestResult.total` or add IPC/contract schema fields for this — it's a presentation fix plus a new project-local cache file, not a protocol change.
- Do not attempt real-time detection of a test deleted from a file that hasn't been re-run since — it self-heals on that file's next run (full or incremental); this is an accepted, documented limitation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full run, then a test deleted, then the same file re-run incrementally | Inventory has N tests from the full run; the incremental rerun's `tests` for that file has one fewer entry | Inventory count drops by 1 after the incremental run | N/A |
| Incremental run touches a brand-new test file | Inventory has no entry for that file yet | Inventory gains that file's tests; total increases | N/A |
| Run result has `testsTruncated: true` | `tests` capped at 1000 entries | Inventory unchanged for every file in that run | N/A (logged only if the write itself fails) |
| Run with skips, 0 failed | passed=5, failed=0, skipped=2 | Ratio shows "5/5 passed (2 skipped)", still green | N/A |
| Daemon restart | `.test-mcp/test-inventory.json` missing/corrupt | Inventory starts empty for that project and rebuilds as runs occur | Corrupt file skipped with a stderr warning, same as `history/index.ts` |

</frozen-after-approval>

## Code Map

- `src/worker/index.ts` -- `buildSummary()`'s denominator currently includes skipped; fix to `passed/(passed+failed)` plus a separate skipped mention.
- `src/history/index.ts` -- add sibling persistence for the new test inventory, mirroring the existing history read/write/prune pattern (atomic write, schemaVersion, corrupt-file skip).
- `src/orchestrator/index.ts` -- add in-memory per-project inventory (`file -> Set<name>`), reconciled inside `recordRun`; add `loadTestInventory` (startup rehydration) and `getTestInventoryCount(projectId)`.
- `src/daemon/index.ts` -- call the new `loadTestInventory` next to the existing `orchestrator.loadHistory(...)` call (~line 204).
- `src/ui/index.ts` -- swap `uniqueTestTotal(history)` for `orchestrator.getTestInventoryCount(projectId)`; add `skipped` to the `run` snapshot object + `ProjectView.run` type; fix client `passTotal()`; reorder `renderRun()`; wrap Selection/Tests in `<details>`.
- `docs/architecture.md` -- document the new `.test-mcp/test-inventory.json` state file alongside the existing history/coverage-map entries.

## Tasks & Acceptance

**Execution:**
- [x] `src/worker/index.ts` -- change `buildSummary` to report `passed/(passed+failed)` with skipped stated separately -- fixes the misleading denominator at the source
- [x] `src/history/index.ts` -- add `loadTestInventory`/`saveTestInventory` for `.test-mcp/test-inventory.json` (schemaVersioned, atomic write, corrupt-skip) -- durable, deletion-aware per-file test catalog
- [x] `src/orchestrator/index.ts` -- maintain the per-project file→names map, reconcile per-file from `result.selection.files`/`result.tests` in `recordRun` (skip when `testsTruncated`), add `loadTestInventory(projectId, projectPath)` + `getTestInventoryCount(projectId)` -- single source of truth for "total tests", independent of the capped history ring buffer
- [x] `src/daemon/index.ts` -- call `orchestrator.loadTestInventory(p.projectId, p.path)` alongside the existing rehydration call -- survives daemon restarts
- [x] `src/ui/index.ts` -- use the new getter for `totalTests`; add `skipped` to the run view; fix `passTotal()` to divide by executed tests and append "(N skipped)"; move the failures block above Selection/Confidence/Coverage/Tests in `renderRun()`; wrap Selection and Tests in `<details>` (no `open` attribute, so both start collapsed)
- [x] `docs/architecture.md` -- one-line addition documenting the new state file
- [x] Tests -- new hermetic inventory tests (full-run replace, incremental union, per-file deletion on rerun, truncated-skip, corrupt/missing load) + updated `worker-result.test.ts`/`ui-history.test.ts` assertions for the new summary/ratio format and `totalTests` source

**Acceptance Criteria:**
- Given a full run recording 4923 tests, followed by many incremental runs and a daemon restart, when the UI polls `/ui/api/status`, then `totalTests` still reports 4923.
- Given a run with passed=2676, failed=0, skipped=5, when the UI renders its pass/total ratio, then it shows "2676/2676 passed (5 skipped)" in green, not "2676/2681 passed".
- Given a test deleted from a file and that file later re-run, when the UI next polls status, then `totalTests` no longer counts the deleted test.
- Given a run with failures, when the run-detail page renders, then the failures section appears before the Selection section, and Selection/Tests are collapsed by default.

## Spec Change Log

## Design Notes

Reconciliation is per-file rather than per-run-strategy: `result.selection.files` already lists every file the worker actually executed, true for both full and incremental runs. Replacing each of those files' cached test-name sets from `result.tests` therefore handles additions and deletions uniformly, with no `strategy` branch needed.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run build` -- expected: exit 0
- `pnpm test` -- expected: exit 0

**Manual checks (if no CLI):**
- Start the daemon, register a fixture project, run full then incremental, restart the daemon, and confirm `/ui/api/status`'s `totalTests` is stable; screenshot the run-detail page (headless browser) to confirm failures render first with Selection/Tests collapsed.

## Suggested Review Order

**Test inventory reconciliation (the core fix)**

- Entry point: per-file replace/skip logic — the heart of the deletion-aware, restart-durable count.
  [`orchestrator/index.ts:673`](../../src/orchestrator/index.ts#L673)

- A file that fails to load collapses to a synthetic entry; excluded from reconciliation so a transient error can't under-count.
  [`orchestrator/index.ts:684`](../../src/orchestrator/index.ts#L684)

- Startup rehydration and the getter the UI reads instead of the old history-union.
  [`orchestrator/index.ts:634`](../../src/orchestrator/index.ts#L634)

- New sibling persistence: schema-versioned, atomic write, corrupt/malformed data never crashes the daemon.
  [`history/index.ts:95`](../../src/history/index.ts#L95)

- Daemon startup wiring, alongside the existing history rehydration call.
  [`daemon/index.ts:206`](../../src/daemon/index.ts#L206)

**Skipped-test ratio accuracy**

- Denominator excludes skips; an all-skipped run gets its own clear message instead of an ambiguous 0/0.
  [`worker/index.ts:246`](../../src/worker/index.ts#L246)

- Same fix mirrored client-side, plus the "(N skipped)" annotation.
  [`ui/index.ts:273`](../../src/ui/index.ts#L273)

**Run-detail UI: total-tests source swap and reorder**

- `totalTests` now sourced from the durable inventory getter, not the capped history ring buffer.
  [`ui/index.ts:75`](../../src/ui/index.ts#L75)

- Failures moved to render immediately after the status grid — the thing a reviewer came to look at.
  [`ui/index.ts:436`](../../src/ui/index.ts#L436)

- Selection and Tests wrapped in collapsed-by-default `<details>`.
  [`ui/index.ts:443`](../../src/ui/index.ts#L443)

**Peripherals**

- New state-file doc entry, documenting the on-disk shape and self-healing behavior.
  [`architecture.md:162`](../../docs/architecture.md#L162)

- Hermetic reconciliation tests (full-replace, union, per-file deletion, truncation, load-error, empty-selection).
  [`history.test.ts:239`](../../test/history.test.ts#L239)

- Summary-format assertions for the skipped-ratio fix, including the all-skipped edge case.
  [`worker-result.test.ts:151`](../../test/worker-result.test.ts#L151)
