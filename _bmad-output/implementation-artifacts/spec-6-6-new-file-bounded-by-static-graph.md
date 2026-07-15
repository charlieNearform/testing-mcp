---
title: 'Story 6.6 — New source files bounded by the git static graph'
type: 'feature'
created: '2026-07-15'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
baseline_revision: '89f72d3bec5e55a8b692816e2e63dfebec3ded71'
final_revision: '44043ed3e93c0d0a27f4365fa32b14a8a012c0a6'
---

<intent-contract>

## Intent

**Problem:** Adding a **new** source file (unknown to the coverage map) forces a full suite via the "changed source unknown to map → full" rule, even though the new file had no prior runtime dependents — Vitest `--changed`'s static import graph already bounds its impact (its new test + any existing test that statically imports it). The common "add a feature + its test" flow re-runs everything.

**Approach:** Distinguish **new/untracked** changed sources from **modified** ones. When the only unknown-to-map changed sources are new, don't force full — let the existing union path bound them via the git `--changed` static graph. A **modified** source unknown to the map stays conservative (full) — invariant 5; its softening to a confidence signal is Story 6.8, not this story.

## Boundaries & Constraints

**Always:** a new/untracked source unknown to the map is bounded by the git static-graph union (worker `--changed`), not a full suite. A **modified** existing source unknown to the map still triggers the full suite. Setup-baseline triggers, unmeasurable tests, `changedFiles === null` (no git) still force full. `SelectionEngine.plan` stays pure over its inputs. `pnpm run typecheck`/`build`/`test` pass. Aligns with `docs/architecture.md` selection-algorithm step 4 (already ratified).

**Block If:** determining new-vs-modified reliably appears to need more than the untracked-file list git already provides — HALT. Or the change appears to require the confidence signal (Story 6.8, not yet built) to be correct — HALT.

**Never:** do not soften the modified-unmapped-source case here (that is 6.8). Do not change coverage-map building. Do not alter `selection.files` semantics. No new dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New source + its new test, map present | `src/date.ts` (untracked) + `test/date.test.ts` (untracked) changed | incremental, union with git `--changed` (bounds the new test + any existing importer); NOT full | none |
| Lone new source, map present | only `src/date.ts` (untracked) changed | incremental, `union: true`, `testFiles: []` → worker `--changed` selects affected tests; NOT full, NOT empty | none |
| New source imported by an existing test | `src/date.ts` new; `test/existing.test.ts` imports it | git `--changed` includes `test/existing.test.ts` (via static graph) | none |
| Modified existing source unknown to map | tracked `src/legacy.ts` (modified, not in map) changed | full suite (unchanged, conservative) | none |
| Mixed: new unknown + known-mapped source | `src/date.ts` new + `src/foo.ts` (mapped) changed | union: mapped tests for `foo` + git `--changed` (bounds `date`); NOT full | none |
| Setup-baseline / no-git / unmeasurable | as today | full suite (unchanged) | none |

</intent-contract>

## Code Map

- `src/selection/index.ts` -- `getChangedFiles` (also return the untracked/added subset, filtered); `SelectionInput` (+ `addedFiles`); `SelectionEngine.plan` (unknown-to-map source: if new → don't full, rely on union static graph; if modified → full).
- `src/orchestrator/index.ts` -- `resolveSelection` (thread the added set from `getChangedFiles` into `plan`).
- `test/selection.test.ts` -- pure `plan` cases (new-vs-modified unknown source).
- `test/git-selection.test.ts` -- integration (new file + test → not full; modified unmapped → full).

## Tasks & Acceptance

**Execution:**
- [x] `src/selection/index.ts` -- `getChangedFiles` returns `{ files, added } | null`; `added` = untracked (`ls-files --others`) **+ staged-adds (`diff --cached --diff-filter=A`)** (review patch), all filtered. `SelectionInput.addedFiles?`. `plan` with-map loop: unknown source in `addedFiles` → `continue` (bounded by `union` static graph); not in `addedFiles` → full. Union reason notes new-file bounding.
- [x] `src/orchestrator/index.ts` -- `resolveSelection` destructures `{ files, added }` and passes `{ changedFiles, addedFiles, map }` to `plan`.
- [x] `test/selection.test.ts` -- 3 pure cases (new-in-added → union not full; modified-not-in-added → full; lone new → union:true/testFiles:[]).
- [x] `test/git-selection.test.ts` -- 2 integration cases (new src+test with map → not full; modified tracked unmapped → full).
- [x] `test/orchestrator-selection-reason.test.ts` (Story 6.4 test) -- updated its full-decision fixture from a new-untracked to a **tracked-then-modified** unmapped source, since 6.6 now bounds new-untracked sources (cross-story maintenance).

**Acceptance Criteria:**
- Given only a new (untracked) source and its new test changed with a map present, when an incremental run is planned, then it is bounded by the git static graph (not full).
- Given a new source imported by an existing test, when selection runs, then that existing test is included via `--changed`.
- Given a modified existing source unknown to the map, when selection runs, then the full suite still runs (unchanged).
- Given no git, a setup-baseline change, or an unmeasurable test, when selection runs, then the full suite still runs.

## Design Notes

Only `getChangedFiles` can tell new from modified (untracked = `git ls-files --others`); it already computes that set separately, so returning it costs nothing. Keeping `plan` pure over `{changedFiles, addedFiles, map}` preserves unit-testability. The existing with-map return already sets `union: true`, so a new unknown source simply needs to NOT short-circuit to full — the worker's `--changed` pass (run because `changed`/`union` is true) bounds it. A lone new source yields `testFiles: []` with `union: true`, which `resolveSelection` does NOT treat as empty (empty requires `!union`), so the worker still runs `--changed`.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm build` -- expected: exit 0
- `pnpm test` -- expected: exit 0; new plan unit + git-selection integration cases pass

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 1, low 0)
- defer: 2: (high 1, medium 1, low 0)
- reject: 0
- addressed_findings:
  - `[medium]` `[patch]` staged-but-uncommitted new files (`git add`, not committed) weren't in `ls-files --others` → misclassified MODIFIED → forced full (safe but lost the optimization). Added `git diff --cached --diff-filter=A` to the `added` set.
  - deferred `[high]`: bounding a new source by the static `--changed` graph can silently under-run for dynamic-import/side-effect/config edges (no coverage-map signal for a new file), and the worker union branch lacks a full-suite fallback — this is the ratified invariant-5 relaxation whose mitigation is **Story 6.8** (mark bounded-new-file runs degraded + add the worker fallback). → deferred-work.md.
  - deferred `[medium]`: pre-existing `getChangedFiles` edges (quoted non-ASCII paths; unborn HEAD) — both fail to the safe full-suite direction. → deferred-work.md.

## Auto Run Result

Status: done

**Change:** A new/untracked (or staged-added) source unknown to the coverage map is now bounded by the git `--changed` static-graph union instead of forcing a full suite; a MODIFIED unmapped source still forces full (invariant 5 preserved for the case we can't bound). `getChangedFiles` returns `{ files, added }`; `plan` uses `addedFiles` to distinguish new from modified.

**Files changed:**
- `src/selection/index.ts` -- `getChangedFiles` → `{ files, added }` (untracked + staged-adds); `SelectionInput.addedFiles`; `plan` bounds new unmapped sources via union, keeps modified-unmapped full.
- `src/orchestrator/index.ts` -- `resolveSelection` threads `addedFiles` into `plan`.
- `test/selection.test.ts`, `test/git-selection.test.ts` -- pure + integration cases.
- `test/orchestrator-selection-reason.test.ts` -- Story 6.4 test updated to a tracked-modified unmapped source (6.6 changed the new-untracked behavior it relied on).

**Review:** Blind Hunter + Edge Case Hunter (parallel). 1 patch (staged-add detection); 2 deferred (the high-severity dynamic-import/no-fallback risk → Story 6.8 mitigation; pre-existing safe-direction git edges).

**Follow-up review recommended:** false — this pass's only change was the staged-add patch; the substantive risk is deferred to 6.8 (which will be reviewed on its own).

**Verification:** `pnpm run typecheck` exit 0; `pnpm build` exit 0; `pnpm test` exit 0 (36 files, 143 tests).

**Residual risks (IMPORTANT):** new-source bounding relies on static-graph reachability + `--changed` seeing untracked files + `alwaysRun` empty; a dynamic-import-only new file can under-run until Story 6.8 adds the confidence signal + worker union-branch full-suite fallback. Tracked in deferred-work.md.
