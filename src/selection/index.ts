import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CoverageMapFile } from "../coverage/index.js";

/**
 * Selection Engine (Story 3.5) — decides the minimum SAFE set of test files to run
 * for an incremental request, combining two complementary signals:
 *
 *   - the coverage reverse-map (runtime: which tests executed a source), and
 *   - git static-graph selection (Vitest `--changed`; catches statically-imported
 *     tests the runtime map hasn't exercised yet).
 *
 * The guiding rule is correctness over cleverness (architecture invariant 5): when
 * we cannot be sure, we run more, never fewer. A change we can't map conservatively
 * triggers the full suite; unmeasurable tests always run on a relevant change.
 *
 * `plan` is pure (takes the changed-file list + loaded map) so it is unit-testable;
 * `getChangedFiles` does the git I/O.
 */

export type SelectionPlan =
  | { strategy: "full"; reason: string }
  /** No map yet: defer to the worker's git `--changed` pass (Story 3.1). */
  | { strategy: "changed-only"; reason: string }
  | { strategy: "incremental"; reason: string; testFiles: string[]; union: boolean };

export interface SelectionInput {
  /** Repo-relative changed files (working tree vs HEAD, incl. untracked); null if undeterminable. */
  changedFiles: string[] | null;
  /**
   * Repo-relative NEW (untracked) subset of `changedFiles` (Story 6.6). A new source unknown
   * to the map has no prior runtime dependents, so the git static-graph union (`--changed`)
   * bounds it — it does NOT force a full suite the way a MODIFIED unmapped source does.
   */
  addedFiles?: string[];
  /** The project's coverage map, or null if none has been built. */
  map: CoverageMapFile | null;
}

/** A test file by convention (path- or name-based). Matches the Coverage Engine's rule. */
export function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.split("/").includes("__tests__");
}

export class SelectionEngine {
  static plan(input: SelectionInput): SelectionPlan {
    const { changedFiles, addedFiles, map } = input;

    // Can't tell what changed (e.g. not a git repo) -> safest is the full suite.
    if (changedFiles === null) {
      return { strategy: "full", reason: "cannot determine changed files (not a git repo?)" };
    }
    if (changedFiles.length === 0) {
      return { strategy: "incremental", reason: "no changes detected", testFiles: [], union: false };
    }

    const changedTests = changedFiles.filter(isTestFile);
    const changedSources = changedFiles.filter((f) => !isTestFile(f));

    // Only test files changed -> run exactly those (AC1).
    if (changedSources.length === 0) {
      return {
        strategy: "incremental",
        reason: "only test files changed",
        testFiles: unique(changedTests),
        union: false,
      };
    }

    // Source files changed but no map yet -> use the git static-graph pass (Story 3.1 behaviour).
    if (!map) {
      return {
        strategy: "changed-only",
        reason: "source changed; no coverage map yet — using git static-graph",
      };
    }

    // Source files changed WITH a map -> map selection, unioned with the static graph at run time.
    const selected = new Set<string>(changedTests);
    let boundedNewFiles = false;
    for (const src of changedSources) {
      if (map.fullSuiteTriggers.includes(src)) {
        return { strategy: "full", reason: `changed file is a full-suite trigger: ${src}` };
      }
      const entry = map.map[src];
      if (!entry) {
        // Unknown to the map. A NEW (untracked) source has no prior runtime dependents, so the
        // `union: true` git static-graph pass (`--changed`) already bounds it to its new test and
        // any existing importer — no need to force the full suite (Story 6.6). A MODIFIED unmapped
        // source stays conservative: we can't bound its blast radius safely (AC3, invariant 5).
        if (addedFiles?.includes(src)) {
          boundedNewFiles = true;
          continue;
        }
        return { strategy: "full", reason: `changed source unknown to coverage map: ${src}` };
      }
      for (const t of entry.tests) selected.add(t);
    }
    // Unmeasurable tests always run on a relevant (source) change (Story 3.4).
    for (const t of map.alwaysRun) selected.add(t);

    return {
      strategy: "incremental",
      reason: boundedNewFiles
        ? "coverage-map selection unioned with git static-graph (new files bounded by --changed)"
        : "coverage-map selection unioned with git static-graph",
      testFiles: [...selected].sort(),
      union: true,
    };
  }
}

/**
 * Keep-always allowlist (Story 6.5) — files that could change JS/TS test behaviour and so
 * must NEVER be dropped, even if a user `.test-mcp-ignore` pattern would match them. This is
 * the load-bearing safety net for architecture invariant 5 and is checked BEFORE any ignore
 * rule. Paths are POSIX-relative; we match on the basename except for the code-extension rule.
 */
function isKeepAlways(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  // Any JS/TS source (covers *.config.{js,ts,mjs,cjs} and the .mts/.cts module extensions
  // that isTestFile also recognizes). Case-insensitive for case-insensitive filesystems.
  if (/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i.test(base)) return true;
  if (base === "package.json") return true;
  if (base === "pnpm-lock.yaml" || base === "package-lock.json" || base === "yarn.lock") return true;
  if (/^tsconfig.*\.json$/.test(base)) return true;
  if (/^vitest\.setup\./.test(base)) return true;
  return false;
}

/**
 * Built-in default ignore set (Story 6.5): provably test-irrelevant non-code and
 * VCS/editor/agent dotfiles. Combined with any project `.test-mcp-ignore` patterns.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  "*.md",
  "*.mdx",
  "*.txt",
  "docs/**",
  "LICENSE*",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".mcp.json",
  "CLAUDE.md",
  // test-mcp's own per-project state (incl. the last-run snapshot) must never be treated as a
  // source change — otherwise the snapshot's own writes would perpetually re-trigger selection.
  ".test-mcp/**",
  ".cursor/**",
  ".cursorrules",
  ".vscode/**",
  ".idea/**",
  ".github/**",
];

/**
 * Minimal gitignore-style glob → RegExp. Supported forms:
 *   - `*.ext` / bare-name / bare-path globs (`*` → `[^/]*`, does not cross `/`)
 *   - `dir/**` subtrees (`**` → `.*`, crosses `/`)
 *   - leading-`/` root anchoring; a pattern containing a `/` is also root-anchored
 *     (per gitignore), while a slash-free pattern matches the basename at any depth.
 * NOTE: `!` negation and `?` single-char wildcards are intentionally UNSUPPORTED — a `?`
 * is treated as a literal character, and a leading `!` has no special meaning here.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = glob;
  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  } else if (pattern.includes("/")) {
    anchored = true;
  }

  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        body += ".*";
        i++;
      } else {
        body += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      body += "\\" + c;
    } else {
      body += c;
    }
  }

  const prefix = anchored ? "^" : "(?:^|/)";
  return new RegExp(prefix + body + "$");
}

/**
 * Pure filter (Story 6.5): drop paths matched by any ignore `pattern`, EXCEPT keep-always
 * members which are evaluated first and never dropped. Blank lines and `#` comments in
 * `patterns` are skipped. Exported so the matcher + allowlist are unit-testable without git.
 */
export function filterChangedPaths(files: string[], patterns: string[]): string[] {
  const regexps = patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"))
    .map(globToRegExp);
  return files.filter((f) => {
    if (isKeepAlways(f)) return true;
    return !regexps.some((re) => re.test(f));
  });
}

/** Read `<projectRoot>/.test-mcp-ignore` lines; missing/unreadable → no extra patterns. */
function readIgnorePatterns(projectRoot: string): string[] {
  try {
    return fs.readFileSync(path.join(projectRoot, ".test-mcp-ignore"), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

/**
 * Combined ignore patterns for a project: the built-in defaults plus its `.test-mcp-ignore`
 * (Story 6.5). Exported so the Story-6.7 snapshot universe is filtered by the EXACT same rules
 * as the changed-set selection — the two must never diverge.
 */
export function loadIgnorePatterns(projectRoot: string): string[] {
  return [...DEFAULT_IGNORE_PATTERNS, ...readIgnorePatterns(projectRoot)];
}

/**
 * Repo-relative changed files: working tree vs HEAD (tracked) plus untracked files.
 * Returns null when git is unavailable/not a repo so callers fall back to the full suite.
 * Paths are POSIX-style relative to the project root (which is the git root for registered projects).
 *
 * Test-irrelevant paths (built-in defaults + optional `.test-mcp-ignore`) are filtered out
 * here (Story 6.5); an all-filtered set collapses to `[]`, which `plan()` treats as the
 * existing "no changes detected" incremental no-op — not a full suite.
 *
 * `added` is the NEW subset — untracked files (`git ls-files --others --exclude-standard`) plus
 * staged additions (`git diff --cached --diff-filter=A`, so `git add`-ed-but-uncommitted new
 * files still count as new). Normalized and run through the SAME filter as `files`, so the
 * Selection Engine can tell a NEW source (bounded by the git static graph) from a MODIFIED one
 * (still conservative, full suite) (Story 6.6).
 */
export function getChangedFiles(projectRoot: string): { files: string[]; added: string[] } | null {
  try {
    const gitOpts = {
      cwd: projectRoot,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[],
    };
    const tracked = execFileSync("git", ["diff", "--name-only", "HEAD"], gitOpts);
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], gitOpts);
    // Staged-but-uncommitted additions are already in `git diff HEAD` (so in `files`), but not in
    // `ls-files --others`; include them here so a `git add`-ed new file is still classified NEW.
    const stagedAdded = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=A"],
      gitOpts,
    );
    const patterns = loadIgnorePatterns(projectRoot);
    const normalize = (raw: string): string[] =>
      raw
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.split(path.sep).join("/"));
    const untrackedPaths = normalize(untracked);
    const files = unique(filterChangedPaths([...normalize(tracked), ...untrackedPaths], patterns));
    const added = unique(
      filterChangedPaths([...untrackedPaths, ...normalize(stagedAdded)], patterns),
    );
    return { files, added };
  } catch {
    return null;
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
