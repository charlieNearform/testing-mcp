# Fix: Path normalization for subdirectory-registered projects (`register --dir <subdir>`)

Status: done

> **Routed through BMAD retroactively.** A ready-to-apply patch was supplied out-of-cycle and
> applied to the working tree on 2026-09-14 (not yet committed). Per CLAUDE.md, it is recorded
> here and must pass `bmad-code-review` before it lands. Nothing is pushed to `main` until review
> is clean and the orchestrator approves.

## Problem

When a project registers at a repository **subdirectory** (e.g. `test-mcp register --dir frontend`),
`git` commands run from the git root (or emitting repo-root-relative paths) produce paths like
`frontend/src/foo.ts`. The daemon resolved these against `project.path` (`.../frontend`), yielding
`.../frontend/frontend/foo.ts`. Incremental selection then saw every changed path as non-existent
and failed with `changed path no longer exists on disk (deleted): frontend/…`, falling back to the
full suite on every incremental run — defeating incremental selection entirely for subdir-registered
projects.

## Acceptance Criteria

1. Git-derived changed/candidate paths are resolved from the **git root** and mapped to
   **`projectRoot`-relative** POSIX paths, so a `frontend/`-registered project no longer produces
   `frontend/frontend/…` and no longer reports false deletions. ✅
2. Paths **outside** the registered project directory (e.g. `.github/workflows/ci.yml` when
   registered at `frontend/`) are dropped from selection rather than mis-resolved. ✅
3. When `projectRoot` **is** the git root, behaviour is unchanged (paths pass through). ✅
4. When git is unavailable, selection falls back safely (`getChangedFiles`/`listCandidateFiles`
   return `null` → full suite), preserving the "correctness over cleverness" invariant. ✅
5. `pnpm run typecheck`, `pnpm test`, and `pnpm build` all pass. ✅

## What shipped

**New module — `src/git/paths.ts`**
- `resolveGitRoot(projectRoot)` — `git rev-parse --show-toplevel`, or `null` when git is unavailable.
- `toProjectRelativePath(projectRoot, gitRoot, repoRelativePath)` — maps a repo-root-relative POSIX
  path to a `projectRoot`-relative POSIX path via canonicalized (`realpathSync.native`) roots;
  returns `null` when the path is outside the project directory (symlink-safe, `..`-safe).
- `normalizeRepoPathsToProject(projectRoot, repoPaths)` — batch map; short-circuits to a passthrough
  (POSIX-normalized) when git is unavailable or `projectRoot === gitRoot`.

**`src/selection/index.ts`**
- `getChangedFiles` now runs git with `cwd: gitRoot` (returns `null` if no git root) and routes all
  three git outputs (tracked / untracked / staged-added) through `normalizeRepoPathsToProject`.
- `hasDynamicImportSyntax` runs `git grep` from the git root (`resolveGitRoot(projectRoot) ?? projectRoot`).

**`src/snapshot/index.ts`**
- `listCandidateFiles` now runs git with `cwd: gitRoot` (returns `null` if no git root) and routes
  tracked + untracked outputs through `normalizeRepoPathsToProject`.

## Tests

- **New** `test/git-paths.test.ts` — `toProjectRelativePath`: maps under-project path → project-relative;
  returns `null` for outside-project path; passes through when project root == git root.
- Full suite green at **294/294** across **50** files; `typecheck` + `build` clean (2026-09-14).

## Dev Agent Record

**File List**
- `src/git/paths.ts` (new) — `resolveGitRoot`, `toProjectRelativePath`, `splitRepoPathsByProject`
- `src/selection/index.ts` (modified) — `getChangedFiles` (map + escalate), `hasDynamicImportSyntax` (project-scoped grep)
- `src/snapshot/index.ts` (modified) — `listCandidateFiles` (threaded gitRoot, project-scoped)
- `test/git-paths.test.ts` (new/expanded) — unit coverage for `toProjectRelativePath` + `splitRepoPathsByProject`
- `test/git-subdir-selection.test.ts` (new) — git-backed integration for the subdir-registered scenario

**Completion Notes**
- Original patch applied to working tree via `git apply`, then extended with 5 code-review patches
  (see Review Findings): out-of-project escalation policy, project-scoped dynamic-import grep,
  single-resolve/single-canonicalize hot-path cleanup, and integration test coverage.
- Verified: `pnpm run typecheck` clean, `pnpm test` 305/305 (51 files), `pnpm build` clean. Daemon
  restarted by `pnpm build` (pid → 82181) and running the reviewed code locally.
- Review clean (0 unresolved findings). Shipped via PR #1
  (branch `fix/frontend-registered-path-normalization`) against `main`.
- Root-registered projects (projectRoot === gitRoot, incl. this repo) hit the passthrough
  short-circuit in `splitRepoPathsByProject` → zero behavioural change for them.

## Review Findings

_Adversarial code review 2026-09-14 (Blind Hunter + Edge Case Hunter + Acceptance Auditor). Code read and git behaviors empirically verified before rating. All patches applied and verified (typecheck + 305/305 tests + build clean)._

- [x] [Review][Decision→Patch] Cross-directory source changes silently dropped → unsafe under-select (AC2 vs invariant 5) — **Resolved: escalate to full suite.** For a subdir-registered project, a changed sibling/parent path the project depends on was dropped by the old `normalizeRepoPathsToProject`, and if it was the ONLY change `getChangedFiles` returned `{files:[]}` → `plan()` no-op → NO tests run. Decision (Charlie, 2026-09-14): drop only test-irrelevant outside paths (matched by `DEFAULT_IGNORE_PATTERNS` — `.github/**`, `docs/**`, root config, …); escalate to the full suite (`getChangedFiles` returns `null`) for any other outside path. Implemented via `splitRepoPathsByProject` (returns `{inside, outside}`) + an `outsideRelevant` gate in `getChangedFiles`. Note: the snapshot/`selectionDelta` path is project-scoped by design and does not detect cross-package dependency changes — logged as deferred (pre-existing, not introduced here).
- [x] [Review][Patch] No integration test for the subdir-registered scenario — **Fixed.** Added `test/git-subdir-selection.test.ts`: real git repo with the project in `frontend/`, sibling `backend/`, repo-root `.github/`; drives `getChangedFiles`/`listCandidateFiles` for the regression (project-relative mapping, no false deletion), the escalate branch (relevant outside change → null), the drop branch (`.github`/README → no escalation), and the git-unavailable → null branch. Also expanded `test/git-paths.test.ts` with `splitRepoPathsByProject` unit cases (incl. shared-prefix sibling).
- [x] [Review][Patch] `hasDynamicImportSyntax` greps the whole repo → sibling dirs' dynamic imports mis-attributed [src/selection/index.ts] — **Fixed.** Reverted `git grep` to `cwd: projectRoot`; a subdir git grep scopes to that subtree.
- [x] [Review][Patch] Redundant `git rev-parse` + `realpath` per call on the hot path [src/git/paths.ts] — **Fixed.** `getChangedFiles`/`listCandidateFiles` now resolve `gitRoot` once and thread it into `splitRepoPathsByProject`; both roots canonicalized once (not per path); early-return on empty input. Removes the two-independent-probes inconsistency.
- [x] [Review][Patch] `hasDynamicImportSyntax` `?? projectRoot` didn't catch an empty-string gitRoot — **Fixed** (subsumed by the cwd revert above; `resolveGitRoot` also now maps `""` → `null`).

- [x] [Review][Defer] `listCandidateFiles` enumerates the whole repo via `git ls-files` from gitRoot then discards out-of-project paths [src/snapshot/index.ts] — deferred; O(repo) work for a subdir project in a large monorepo. Correctness fine; scope with a `-- <subdir>` pathspec later. Logged in deferred-work.md.
- [x] [Review][Defer] Submodule-hosted project files invisible to `git ls-files` (no `--recurse-submodules`) — deferred, pre-existing limitation not introduced by this patch. Logged in deferred-work.md.

_Dismissed as noise (3): `.trim()` on `-z` output (pre-existing; NUL output carries no surrounding whitespace); `canonicalPath` realpath-throw asymmetry (gitRoot is an ancestor of projectRoot — both exist at daemon runtime, resolve identically); absolute paths in git output (these commands never emit them)._
