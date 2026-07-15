---
title: 'Story 6.7 — "Changed since last run" incremental baseline'
type: 'feature'
created: '2026-07-15'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
baseline_revision: 'a104e2fb39539a43efd2606a669e93e9158897f4'
final_revision: 'bedcdb865550f8d37d8816f8f2dfd0c5e1e06a6e'
---

<intent-contract>

## Intent

**Problem:** Incremental selection diffs against git HEAD, so a long uncommitted session grows the changed set without bound and incremental degrades toward full. A "changed since the last run" baseline is tighter and matches edit→run→edit→run.

**Approach:** Persist a per-project content-hash snapshot of the candidate files. Default the incremental baseline to "since last run": the changed set is files whose current hash differs from the snapshot (added/modified/deleted). `since: "head"` keeps the git-HEAD baseline. The snapshot is advanced **only after a successful delta-driven run** (never on failure), so a changed-but-unvalidated file is never hidden from the next delta. First run (no snapshot) falls back to the HEAD baseline, then writes the snapshot.

## Boundaries & Constraints

**Always:** the snapshot is written to `<git-root>/.test-mcp/last-run-snapshot.json` (git-ignored, `schemaVersion`), atomically (tmp+rename). The snapshot advances only after a run that (a) succeeded and (b) was the delta-driven incremental run (not an explicit-files run). On any failure, the snapshot is unchanged so the same delta re-runs. First run / missing / wrong-schema / unreadable snapshot → fall back to the git-HEAD baseline (never under-select). The candidate universe = git-tracked ∪ untracked ∪ staged-adds, run through the Story-6.5 ignore filter (reuse it). Node built-ins only (crypto for sha256). `pnpm run typecheck`/`build`/`test` pass. Matches `docs/architecture.md` selection-algorithm step 1 + Data Model.

**Block If:** achieving "advance only validated files" appears to require per-(source,test) execution attribution the run result doesn't already provide — then implement the sound conservative model (advance all on a successful delta run, none on failure) and DEFER finer granularity; do not block. If it appears to need Story 6.8's confidence signal to be correct — HALT.

**Never:** never under-select — any uncertainty (no snapshot, hash error, git error) falls back to HEAD/full. Do not change the coverage map or `plan`'s branch semantics beyond feeding it the since-last-run changed set. No new dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First incremental run, no snapshot, `since:last-run` | no snapshot file | fall back to HEAD baseline for selection; after a successful run, write the snapshot | snapshot write failure → run still returns; logged to stderr |
| Second run after editing one file | snapshot present; `src/a.ts` hash changed | changed set = `{src/a.ts}` (not the whole HEAD diff); select its tests | none |
| Edit then revert before running | file content returns to snapshot hash | not in the changed set (hash matches) | none |
| Deleted file | file in snapshot, absent now | included in changed set as a deleted path; a deleted mapped source → its tests run; unknown deleted source → full (conservative) | none |
| `since: "head"` | opt-out flag | use the existing git-HEAD `getChangedFiles` baseline | none |
| Run fails | delta-driven run returns failures/error | snapshot NOT advanced → same delta re-runs next time | none |
| Explicit `files` run | user passed specific files | snapshot NOT advanced (not a delta-driven run) | none |

</intent-contract>

## Code Map

- `src/snapshot/index.ts` (NEW) -- `computeHashes(projectRoot, files)`, `loadSnapshot`/`saveSnapshot` (schemaVersioned, atomic), `changedSinceSnapshot(projectRoot)` → `{ files, added } | null` mirroring `getChangedFiles`'s shape (added = files absent from snapshot; deletions included in `files`). Reuses the candidate-listing + `filterChangedPaths` from `src/selection`.
- `src/selection/index.ts` -- export the candidate-listing + filter bits `snapshot` needs (or keep `snapshot` calling `getChangedFiles`'s helpers); keep `plan` pure.
- `src/orchestrator/index.ts` -- `resolveSelection` picks baseline by `opts.since` (default `"last-run"`); after a successful delta-driven incremental run, `saveSnapshot`. Add `since` to `runTests` opts and the `run_tests` tool input.
- `src/mcp/server.ts` -- `run_tests` input schema gains `since: z.enum(["last-run","head"]).optional()`.
- `test/snapshot.test.ts` (NEW) -- hash/diff/persist unit + round-trip.
- `test/git-selection.test.ts` -- integration: first run writes snapshot; second run after one edit selects only that file's tests; revert → no-op; deletion handled; failed run doesn't advance.

## Tasks & Acceptance

**Execution:**
- [x] `src/snapshot/index.ts` (NEW) -- content-hash snapshot: list candidate files (tracked ∪ untracked ∪ staged-adds, filtered via the 6.5 filter), sha256 each (`node:crypto`), `loadSnapshot`/`saveSnapshot` at `<root>/.test-mcp/last-run-snapshot.json` (`schemaVersion`, atomic tmp+rename), and `changedSinceSnapshot(projectRoot): { files, added } | null` (null → caller falls back to HEAD). Deletions (in snapshot, absent now) are included in `files`, not `added`. **Review patches:** `loadSnapshot` now validates the file with a Zod schema at the persistence boundary (rejects non-string hash values); added `selectionDelta` (one hash pass returning both the diff AND a `pending` payload captured at selection time).
- [x] `src/orchestrator/index.ts` -- `resolveSelection`: for incremental with no explicit files, choose the changed set by `opts.since` (`"last-run"` default → `selectionDelta`, falling back to `getChangedFiles` when the diff is null / no snapshot; `"head"` → `getChangedFiles` + `snapshotPayload`). After a **successful, delta-driven** incremental run, persist the **selection-time** `pendingSnapshot` (not a post-run re-hash); do NOT persist on failure or for explicit-files/full runs. Thread `since` through `runTests` opts.
- [x] `src/mcp/server.ts` -- add `since?: "last-run" | "head"` to the `run_tests` input schema and forward it.
- [x] `src/selection/index.ts` -- **review patch:** added `.test-mcp/**` to `DEFAULT_IGNORE_PATTERNS` so the snapshot's own writes never re-trigger selection in a consumer project that forgot to git-ignore `.test-mcp/`.
- [x] `test/snapshot.test.ts` (NEW) -- unit: hashing stable; diff detects add/modify/delete; revert → no diff; persist/load round-trip + wrong-schema → treated as absent; **+ review-patch tests:** `selectionDelta` captures selection-time state; persisting the selection-time payload keeps a mid-run edit visible in the next delta (invariant 5); `loadSnapshot` rejects a non-string hash value.
- [x] `test/git-selection.test.ts` -- integration: first run (no snapshot) falls back + writes snapshot; edit one file → next run's delta is just that file; revert → no-op; deleted mapped source → its tests; failed run leaves snapshot unchanged (same delta re-runs).

**Acceptance Criteria:**
- Given a snapshot from the previous run, when an incremental run uses `since:last-run`, then the changed set is the hash-diff vs the snapshot (not the HEAD diff), and only affected tests run.
- Given a successful delta-driven run, when it finishes, then a fresh snapshot is persisted; given a failed run, the snapshot is unchanged.
- Given no valid snapshot, when a `since:last-run` run is requested, then it falls back to the HEAD baseline and never under-selects.
- Given a file changed then reverted before a run, when selection runs, then it is not selected (hash matches).
- Given the caller passes `since:"head"`, when selection runs, then the git-HEAD baseline is used.

## Design Notes

The snapshot is the working-tree content hashes of the candidate universe as of the last successful delta-driven run. Advancing **only on success** (whole-snapshot re-hash) is the sound conservative model: a changed file whose run failed is never hidden — it stays in the next delta (its hash still differs from the not-advanced snapshot). Finer per-file "advance only the validated subset even when other files failed" is a deferred optimization (see deferred-work), not required for soundness. Reuse the Story-6.5 candidate-listing + `filterChangedPaths` so the snapshot universe matches selection's changed-set universe exactly. `changedSinceSnapshot` returns the same `{ files, added }` shape as `getChangedFiles` so `plan` and the 6.6 new-vs-modified logic work unchanged (a path absent from the snapshot is "added").

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm build` -- expected: exit 0
- `pnpm test` -- expected: exit 0; new snapshot unit + git-selection integration cases pass

## Review Triage Log

### 2026-07-15 — Review pass (Blind Hunter + Edge Case Hunter, parallel)
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 1, medium 1, low 1)
- defer: 3: (high 1, medium 1, low 2)
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` **Post-run re-hash lost update.** `advanceSnapshotIfDeltaRun` re-hashed the working tree AFTER the run, so a file edited mid-run had its new content baselined as "validated" → hidden from the next delta (under-select, invariant 5). Fixed by capturing the candidate hashes at SELECTION time (`selectionDelta().pending`) and persisting that verbatim on success — never a post-run re-read. Also halves the hash passes (was: hash at selection + hash at advance). Regression test added.
  - `[medium]` `[patch]` **`.test-mcp/` self-diff.** The snapshot avoided hashing itself only because the repo git-ignores `.test-mcp/`; a consumer project that forgot to would see `last-run-snapshot.json`'s own `takenAt` change every write → perpetual non-empty delta (defeats the optimization). Added `.test-mcp/**` to `DEFAULT_IGNORE_PATTERNS` so exclusion no longer depends on the consumer's `.gitignore`.
  - `[low]` `[patch]` **Boundary validation.** `loadSnapshot` cast `JSON.parse` and only checked `schemaVersion` + `typeof files === "object"` (accepts arrays / non-string values), violating CLAUDE.md's "validate file input with Zod at the boundary". Replaced with a Zod schema (`z.record(z.string(), z.string())`); regression test for a non-string hash value.
  - deferred `[high]`: the since-last-run `added` set (absent-from-snapshot) is a superset of `getChangedFiles`'s, so a committed-since-last-run-then-modified source reached only by a dynamic import can under-run — SAME class as 6.6's deferred dynamic-import risk; 6.8's confidence signal + worker union-branch fallback covers both. → deferred-work.md.
  - deferred `[medium]`: whole-candidate-set synchronous hashing per run — perf/latency on large monorepos / large tracked binaries; mitigate with an `ls-files -m`/mtime pre-filter, stream hashing, and/or a size cap. → deferred-work.md.
  - deferred `[low]`×2: newline-split `git ls-files` misses `core.quotePath` non-ASCII names (the one under-select edge — bundle the `-z` fix with 6.6's deferral); symlink-to-dir/gitlink/FIFO candidates throw `EISDIR` → skipped → perpetually "changed" (over-select, safe); tmp name `${target}.${pid}.tmp` is collision-safe only under the per-project queue (latent). → deferred-work.md.
- verified_not_reachable:
  - Both hunters flagged "an empty (0-test) run advances the snapshot over an unvalidated change." Tracing `resolveSelection`, `empty: true` is returned ONLY at the `testFiles.length === 0 && !plan.union` branch, which is reachable only for "no changes detected" — a stale-map miss yields `full`/`changed-only`/`union` (never empty). So a non-empty delta can never advance via an empty run; the empty advance is a genuine no-op (and now, captured at selection time, is safe against mid-run edits too).

## Auto Run Result

Status: done

**Change:** Incremental selection now defaults to a "since last run" baseline: a per-project content-hash snapshot of the candidate universe (`<root>/.test-mcp/last-run-snapshot.json`, `schemaVersion`, atomic write) taken as of the last SUCCESSFUL delta-driven run. `changedSinceSnapshot`/`selectionDelta` diff current hashes vs the snapshot instead of vs git HEAD; `since: "head"` opts out. A missing/invalid snapshot or git error falls back to the git-HEAD baseline (never under-select). The snapshot advances only after a successful delta-driven run, and — per review — is captured at SELECTION time so an edit landing mid-run is never baselined as validated.

**Files changed:**
- `src/snapshot/index.ts` (NEW) -- `listCandidateFiles`, `computeHashes`, `loadSnapshot` (Zod-validated) / `saveSnapshot` (atomic), `snapshotPayload`, `selectionDelta` (diff + selection-time `pending`), `changedSinceSnapshot`, `writeCurrentSnapshot`.
- `src/orchestrator/index.ts` -- `resolveSelection` picks the baseline by `opts.since` and captures `pendingSnapshot`; `advanceSnapshotIfDeltaRun` persists the selection-time payload on a successful delta run; `since` threaded through `runTests`.
- `src/mcp/server.ts` -- `run_tests` input gains `since?: "last-run" | "head"`.
- `src/selection/index.ts` -- `.test-mcp/**` added to `DEFAULT_IGNORE_PATTERNS` (review patch).
- `test/snapshot.test.ts` (NEW) -- hashing/diff/round-trip + Zod-boundary + selection-time-capture (mid-run-edit) regression cases.
- `test/git-selection.test.ts` -- since-last-run integration cases.

**Review:** Blind Hunter + Edge Case Hunter (parallel). 3 patches applied (post-run lost-update → capture at selection time; `.test-mcp/**` ignore; Zod boundary validation); 3 deferred (dynamic-import under-select → 6.8; whole-set hashing perf; minor git/FS edges incl. the shared `-z` fix). One flagged "empty run advances" verified not reachable.

**Follow-up review recommended:** false — the substantive residual (dynamic-import under-select) is the ratified relaxation already owned by Story 6.8; the perf and git-parsing items are safe-direction and tracked in deferred-work.

**Verification:** `pnpm run typecheck` exit 0; `pnpm build` exit 0; `pnpm test` exit 0 (37 files, 159 tests; +4 review-patch tests over the 155 baseline).

**Residual risks (IMPORTANT):** since-last-run bounding of a new/unmapped source relies on the same static-graph reachability as 6.6 — a dynamic-import-only edge can under-run until Story 6.8 lands the confidence signal + worker union-branch fallback. Large-repo hashing cost is a known safe-direction perf trade-off. Tracked in deferred-work.md.
