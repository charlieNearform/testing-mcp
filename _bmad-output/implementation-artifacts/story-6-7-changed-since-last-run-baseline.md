# Story 6.7: "Changed Since Last Run" Incremental Baseline

**ID:** `6-7`
**Slice:** `src/selection`, `src/orchestrator`
**Type:** `feature`
**Depends on:** `6-0` (relates to 6.4/6.5/6.6; complements them)
**Status:** ready-for-dev

## Source

Observed 2026-07-15: incremental selection uses "changed vs git HEAD" (`getChangedFiles` =
`git diff --name-only HEAD` + untracked). As you work without committing, that delta grows
without bound, so incremental degrades toward the full suite — much less useful than expected
for an edit → run → edit → run loop. A **"changed since the last run"** baseline is tighter and
matches actual iteration: only re-test what you've touched since you last ran tests.

- Related: `src/selection/index.ts` (`getChangedFiles`, `SelectionEngine.plan`), Story 3.1
  (git delta), 3.5 (union + fallback), 6.6 (new-file handling), `docs/architecture.md`.

## Acceptance criteria

1. **Given** a per-project snapshot of the working tree exists from the previous run
   **When** an incremental run uses the "last-run" baseline
   **Then** the changed-set is the files whose content differs from that snapshot (not the git
   HEAD diff), and selection runs the tests affected by just those files.

2. **Given** a run completes
   **When** it finishes
   **Then** the daemon persists an updated snapshot (schema-versioned, under `.test-mcp/`,
   git-ignored) capturing the current content hashes of the candidate files, so the next run's
   delta is measured against this run.

3. **Given** no snapshot exists yet (first run for a project, or a purged/invalid snapshot)
   **When** a "last-run" incremental run is requested
   **Then** it falls back safely (full suite or the git-HEAD delta) to establish the baseline,
   then persists a snapshot — never silently under-selecting.

4. **Given** the baseline is selectable
   **When** `run_tests` is called
   **Then** the caller can choose the baseline (e.g. incremental `since: "last-run" | "head"`),
   with a documented default; the git-HEAD baseline remains available (CI wants "changed vs
   branch base").

5. **Given** a file changed then reverted to the snapshot's content before a run
   **When** selection runs
   **Then** it is not selected (net no change) — hashing, not mtimes, drives the delta.

## Out of scope

- Cross-machine/shared snapshots (per-project local file only).
- Distinguishing pass/fail when advancing the snapshot in v1 (snapshot after each run; a
  smarter "only advance validated files" model is a later refinement).
- Replacing coverage-map / static-graph selection — this only changes *how the changed-set is
  computed*; the changed-set still feeds the existing selection logic.

## Notes for the agent

- **Snapshot**: `<git-root>/.test-mcp/last-run-snapshot.json` — `{ schemaVersion, takenAt,
  files: { <relpath>: <sha256> } }`. Candidate universe = files git tracks + untracked
  (exclude git-ignored): reuse `git ls-files` + `git ls-files --others --exclude-standard` to
  list, then hash each. Write atomically (temp + rename, like `saveCoverageMap`).
- **Changed-set**: current hashes vs snapshot → added/modified paths (a path missing from the
  snapshot = new, treat per 6.6; a path missing now = deleted, ignore for selection).
- **Where**: compute in a new helper alongside `getChangedFiles` (e.g.
  `getChangedSinceSnapshot(projectRoot)`); the orchestrator picks HEAD vs last-run based on the
  request. Persist the snapshot in the run path (e.g. after `recordRun`), keyed by project.
- **Static-graph interplay**: Vitest `--changed` (fast path A) is git-HEAD-based and does not
  apply to a last-run delta — for last-run, drive selection from the coverage map + changed
  test files + 6.6 new-file handling, and keep the conservative full-suite fallback for unknown
  cases. Spell out this interaction; don't silently drop the fallback.
- Keep `SelectionEngine.plan` pure over the changed-set; only the *source* of the changed-set
  differs.
- Tests hermetic (temp git repo): first run → baseline + snapshot; edit one file → next run
  selects only its tests; revert → not selected; new file → per 6.6.

## Escalation triggers

- **Changes core selection semantics and the default baseline** — reconcile with the
  architecture spine (invariant 5 / selection algorithm) before implementing, alongside 6.6.
  Decide the default (recommend "last-run" for local dev, "head" for CI) with the orchestrator.
- If advancing the snapshot after a *partial* (incremental) run could ever mark an unvalidated
  changed file as "seen", escalate — the safe rule is a run's snapshot must not hide a file
  that wasn't actually exercised.

## Ratified update (course-correction 2026-07-15)

Ratified by `sprint-change-proposal-2026-07-15.md`:
- **`since: "last-run"` is the DEFAULT** (opt-out to `"head"`) — this is default behaviour, not
  opt-in.
- **Snapshot advances only for validated (actually-exercised) files** — confirmed as an AC, not
  just an escalation note.
- **Deletions are in scope**: a deleted source imported by a test still runs/flags that test; a
  deletion whose impact can't be bounded feeds the confidence signal (Story 6.8).
- Reflected in `docs/architecture.md` (selection algorithm step 1, `last-run-snapshot.json`).

## Post-hoc correction (2026-07-16)

**Found in use** against the `sanity-check` project: an edit → run → edit → run loop kept
re-running tests for files already validated by a prior run, as long as they stayed
uncommitted. Root cause — the shipped `SelectionEngine.plan` set `union: true`
**unconditionally** whenever any source changed and a map existed, ignoring this story's own
"Static-graph interplay" note above (`A` is git-HEAD-based and does not apply to a last-run
delta). Since `union: true` makes the worker also run Vitest's real `--changed` (HEAD-scoped),
every run kept resurfacing everything uncommitted since HEAD regardless of `since`, silently
defeating the last-run baseline for any project with a coverage map. This also meant Story
6.8 AC1 ("all changed sources mapped and re-measured → provably complete") was never actually
reached without the redundant static-graph pass riding along.

**Fix**: `union` is now `true` only when some changed source is unmapped (the static graph is
then the sole signal for it — Story 6.6 new-file handling is unaffected). A fully-mapped,
re-measured selection now runs via the coverage map alone, matching this story's original
static-graph-interplay intent. See `src/selection/index.ts` (`unmappedSourceSeen`),
`src/worker/index.ts` (zero-modules-run → full-suite fallback extended to the non-union path,
since it lost the union branch's existing safety net), `test/selection.test.ts`,
`test/selection-integration.test.ts`, and `docs/architecture.md` (selection algorithm step 5).
