import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/** Resolve the git worktree root for `projectRoot`, or null when git is unavailable. */
export function resolveGitRoot(projectRoot: string): string | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/**
 * Map a repo-root-relative POSIX path to `canonProject`-relative POSIX, given both roots already
 * canonicalized. Returns null when the path is not strictly inside the project directory.
 */
function relFromCanonicalRoots(
  canonProject: string,
  canonGit: string,
  posixPath: string,
): string | null {
  const abs = path.join(canonGit, posixPath);
  const rel = path.relative(canonProject, abs);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${path.sep}`)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}

/**
 * Git commands run from the repository root emit repo-root-relative POSIX paths.
 * Registered vitest projects may be a subdirectory (e.g. `frontend/`); normalize
 * to paths relative to `projectRoot` for existence checks and Vitest `related`.
 * Returns null when the path is outside the project directory. Roots are canonicalized
 * (`realpathSync.native`) so a symlinked project/git root (e.g. macOS `/tmp`→`/private/tmp`)
 * compares and relativizes consistently.
 */
export function toProjectRelativePath(
  projectRoot: string,
  gitRoot: string,
  repoRelativePath: string,
): string | null {
  return relFromCanonicalRoots(
    canonicalPath(projectRoot),
    canonicalPath(gitRoot),
    repoRelativePath.split(path.sep).join("/"),
  );
}

/** Repo paths partitioned by whether they fall inside the registered project directory. */
export interface RepoPathSplit {
  /** Paths inside `projectRoot`, mapped to `projectRoot`-relative POSIX. */
  inside: string[];
  /** Paths outside `projectRoot`, kept as repo-root-relative POSIX (unmapped). */
  outside: string[];
}

/**
 * Partition repo-root-relative git paths into those inside `projectRoot` (mapped to
 * project-relative POSIX) and those outside it (kept repo-root-relative). The caller (`gitRoot`
 * already resolved once) decides what to do with `outside` — the snapshot universe drops them,
 * while the changed-set escalates to the full suite for any relevant one (architecture invariant 5).
 *
 * When git is unavailable (`gitRoot` null) or the project IS the git root — the common case, incl.
 * every root-registered project — every path is `inside` and returned POSIX-normalized, so those
 * projects see no behavioural change and pay no `realpath` cost. Both roots are canonicalized once
 * here (not per path).
 */
export function splitRepoPathsByProject(
  projectRoot: string,
  gitRoot: string | null,
  repoPaths: string[],
): RepoPathSplit {
  const posixAll = repoPaths.map((p) => p.split(path.sep).join("/"));
  if (!gitRoot) {
    return { inside: posixAll, outside: [] };
  }
  const canonGit = canonicalPath(gitRoot);
  const canonProject = canonicalPath(projectRoot);
  if (canonProject === canonGit) {
    return { inside: posixAll, outside: [] };
  }
  const inside: string[] = [];
  const outside: string[] = [];
  for (const posix of posixAll) {
    const rel = relFromCanonicalRoots(canonProject, canonGit, posix);
    if (rel === null) {
      outside.push(posix);
    } else {
      inside.push(rel);
    }
  }
  return { inside, outside };
}
