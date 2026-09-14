import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveGitRoot, splitRepoPathsByProject } from "../git/paths.js";
import type { Confidence } from "../types/contracts.js";

export type { Confidence };

/**
 * Selection Engine (Story 3.5, simplified/unified in Story 3.8) — decides the minimum SAFE set
 * of changed files to hand to Vitest's `related` config field for an incremental request.
 *
 * Story 3.8 retired the reverse coverage map entirely: a single Vitest pass can report an
 * aggregate coverage percentage, but never per-test attribution (which test covers which
 * source) — that requires measuring test files separately, which is exactly what "exactly one
 * Vitest pass, every run" forbids. `related` (an explicit file list resolved through Vitest's
 * own static import graph, confirmed live to skip Vitest's own git lookup entirely) replaces
 * both the old map-based lookup and the old git `--changed` fallback with ONE mechanism.
 *
 * The guiding rule is still correctness over cleverness (architecture invariant 5): when we
 * cannot be sure, we run more, never fewer. `plan` is pure (takes the changed-file list) so it
 * is unit-testable; `getChangedFiles` does the git I/O.
 */

export type SelectionPlan =
  | { strategy: "full"; reason: string; confidence: Confidence }
  | {
      strategy: "incremental";
      reason: string;
      /** Fed verbatim into Vitest's `related` config field (Story 3.8); empty means nothing to run. */
      relatedFiles: string[];
      confidence: Confidence;
    };

export interface SelectionInput {
  /** Repo-relative changed files (working tree vs HEAD, incl. untracked); null if undeterminable. */
  changedFiles: string[] | null;
  /**
   * Repo-relative NEW (untracked) subset of `changedFiles` (Story 6.6). Retained for callers,
   * but no longer part of the confidence decision: a MODIFIED source reached only via a dynamic
   * import is exactly as invisible to `related`'s static graph as a brand-new one, so AC6's
   * caveat is keyed off `dynamicImportsPresent` alone, not new-vs-modified.
   */
  addedFiles?: string[];
  /**
   * Whether the project has any dynamic-import syntax at all (`hasDynamicImportSyntax`). A
   * changed source (new OR modified) is only a static-graph blind spot (AC6) if something reaches
   * it via a dynamic import that `related`'s static graph can't see; when the project has none
   * anywhere, that specific caveat doesn't apply. Undefined (caller didn't check) is treated as
   * "might have one" — conservative, matching prior behaviour.
   */
  dynamicImportsPresent?: boolean;
  /**
   * Total distinct test files in the project's known inventory (size-based full-run escalation),
   * or 0/undefined when there is no inventory yet. Only ever consulted on the final auto-computed
   * incremental path (never for `full` or the empty short-circuit) so a caller with no
   * denominator, or one that already resolved a different strategy, is unaffected.
   */
  totalTestFileCount?: number;
}

const HIGH: Confidence = { level: "high", reasons: [] };
function degraded(reasons: string[]): Confidence {
  return { level: "degraded", reasons };
}

/** Default fraction of the project's known test files above which an auto-computed incremental
 *  selection escalates to a full run instead (its per-file selection overhead can otherwise make
 *  it slower than just running everything). */
const DEFAULT_INCREMENTAL_FULL_THRESHOLD = 0.7;

/** Env-configurable numeric override, range-checked: a fraction must be `(0, 1]` to mean
 *  anything as "a fraction of the suite." Unlike a plain `Number.isFinite` guard (which does
 *  NOT catch this), an accidentally-blank env value (`Number("") === 0`, finite) would otherwise
 *  silently make EVERY incremental selection escalate to full — inverting the whole feature
 *  rather than falling back to the default as intended. A value `<= 0` or `> 1` is equally
 *  nonsensical (always-escalate / never-escalate) and gets the same fallback. Found via
 *  adversarial review, not anticipated originally. */
function getIncrementalFullThreshold(): number {
  const raw = Number(
    process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD ?? DEFAULT_INCREMENTAL_FULL_THRESHOLD,
  );
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_INCREMENTAL_FULL_THRESHOLD;
}

/** A test file by convention (path- or name-based). The single canonical rule for this repo —
 *  the worker's native-coverage report builder imports this copy rather than duplicating it. */
export function isTestFile(rel: string): boolean {
  // Split on BOTH separators: the worker's coverage-report builder passes paths through
  // `path.relative`, which yields backslashes on Windows, so a `\`-only split would miss a
  // `__tests__` segment there.
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.split(/[\\/]/).includes("__tests__");
}

export class SelectionEngine {
  static plan(input: SelectionInput): SelectionPlan {
    const { changedFiles, dynamicImportsPresent, totalTestFileCount } = input;
    const mightMissDynamicImport = dynamicImportsPresent !== false;

    // Can't tell what changed (e.g. not a git repo) -> full suite, which IS complete -> high.
    if (changedFiles === null) {
      return {
        strategy: "full",
        reason: "cannot determine changed files (not a git repo?)",
        confidence: HIGH,
      };
    }
    if (changedFiles.length === 0) {
      return {
        strategy: "incremental",
        reason: "no changes detected",
        relatedFiles: [],
        confidence: HIGH,
      };
    }

    const changedSources = changedFiles.filter((f) => !isTestFile(f));

    // Only test files changed -> `related` matches each test file to itself (AC1): provably
    // complete, no source-side dependency-graph uncertainty possible.
    if (changedSources.length === 0) {
      return {
        strategy: "incremental",
        reason: "only test files changed",
        relatedFiles: unique(changedFiles),
        confidence: HIGH,
      };
    }

    // Size-based full-run escalation (Task 3.4, unchanged mechanism): bounds the RELATED file
    // list itself (there is no resolved test-file count to bound anymore -- Vitest's own graph
    // resolves that at run time, not here) against the project's known test-file inventory. A
    // zero/undefined denominator (no inventory yet) must never divide-by-zero into a false "full".
    if (totalTestFileCount) {
      const fraction = changedFiles.length / totalTestFileCount;
      if (fraction > getIncrementalFullThreshold()) {
        // Clamped to 100 -- the related list can exceed the known test-file total (e.g. a source
        // change alongside several just-added test files), and an uncapped percentage would read
        // as a nonsensical "150% of the suite." The raw numerator/denominator are still reported
        // alongside it, so nothing is hidden.
        const pct = Math.min(100, Math.round(fraction * 100));
        return {
          strategy: "full",
          // A full run IS complete regardless of why it was chosen -> high, same as any other
          // full-suite decision above.
          reason: `incremental selection's related-file list is ${pct}% the size of the suite (${changedFiles.length}/${totalTestFileCount} known test files); running full for speed`,
          confidence: HIGH,
        };
      }
    }

    // The residual blind spot (AC6): `related`'s static import graph can't see a dynamic
    // `import()`/`require(...)` edge, so a source reached ONLY that way could be missed. This is
    // true for a MODIFIED source exactly as for a brand-new one -- new-vs-modified doesn't change
    // whether the dynamic edge is invisible -- so when the project has any such syntax at all
    // (`mightMissDynamicImport`) every changed source is flagged; when it has none, the blind spot
    // can't exist and confidence stays high (the short-circuit below).
    const flaggedSources = mightMissDynamicImport ? changedSources : [];
    const confidence = flaggedSources.length
      ? degraded(
          flaggedSources.map(
            (s) => `changed source may be reachable only via a dynamic import the static import graph can't see: ${s}`,
          ),
        )
      : HIGH;

    return {
      strategy: "incremental",
      reason: "source changed; resolved via Vitest's related static import graph",
      relatedFiles: unique(changedFiles),
      confidence,
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
  if (/^vitest\.(setup|workspace)\./.test(base)) return true;
  // Non-JS build/test configs (the JS/TS forms are already covered by the extension rule above).
  // These can change test behaviour, so a broad user ignore (e.g. `*.json`) must not drop them.
  if (/^(babel|jest)\.config\./.test(base)) return true;
  if (base === ".mocharc" || /^\.mocharc\./.test(base)) return true;
  if (base === ".swcrc") return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
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

/** Read `<projectRoot>/.test-mcp-ignore` lines; a missing file → no extra patterns. An unexpected
 *  read error (e.g. EACCES/EISDIR) is warned to stderr — safe (patterns just aren't applied, so more
 *  runs) but not silently swallowed. */
function readIgnorePatterns(projectRoot: string): string[] {
  try {
    return fs.readFileSync(path.join(projectRoot, ".test-mcp-ignore"), "utf8").split(/\r?\n/);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      process.stderr.write(
        `[test-mcp] could not read .test-mcp-ignore (${
          err instanceof Error ? err.message : String(err)
        }); ignoring it\n`,
      );
    }
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
 * For a project registered at a repo SUBDIRECTORY (e.g. `frontend/`), git emits repo-root-relative
 * paths for the WHOLE repo; in-project paths are mapped to project-relative, and any changed path
 * OUTSIDE the project that isn't test-irrelevant (see `DEFAULT_IGNORE_PATTERNS`, which covers
 * `.github/**`, `docs/**`, root config, …) could be a dependency `related`'s static graph can't
 * trace — so we escalate to the full suite (return null) rather than silently dropping it
 * (architecture invariant 5). Root-registered projects have no outside paths and are unaffected.
 *
 * `added` is the NEW subset — untracked files (`git ls-files --others --exclude-standard`) plus
 * staged additions (`git diff --cached --diff-filter=A`, so `git add`-ed-but-uncommitted new
 * files still count as new). Normalized and run through the SAME filter as `files`, so the
 * Selection Engine can tell a NEW source (bounded by the git static graph) from a MODIFIED one
 * (still conservative, full suite) (Story 6.6).
 */
export function getChangedFiles(projectRoot: string): { files: string[]; added: string[] } | null {
  try {
    const gitRoot = resolveGitRoot(projectRoot);
    if (!gitRoot) return null;
    const gitOpts = {
      cwd: gitRoot,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[],
    };
    // `-z` (NUL-delimited) so non-ASCII / spaced paths are emitted raw, not octal-quoted — a
    // newline+quote split would never match such a path and would silently drop it from selection.
    const tracked = execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], gitOpts);
    const untracked = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], gitOpts);
    // Staged-but-uncommitted additions are already in `git diff HEAD` (so in `files`), but not in
    // `ls-files --others`; include them here so a `git add`-ed new file is still classified NEW.
    const stagedAdded = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "-z", "--diff-filter=A"],
      gitOpts,
    );
    const patterns = loadIgnorePatterns(projectRoot);
    const splitGitPaths = (raw: string) =>
      splitRepoPathsByProject(
        projectRoot,
        gitRoot,
        raw
          .split("\0")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    const trackedSplit = splitGitPaths(tracked);
    const untrackedSplit = splitGitPaths(untracked);
    const stagedSplit = splitGitPaths(stagedAdded);
    // A relevant change outside the project directory (a sibling/parent path not covered by the
    // built-in ignore set) may be a dependency `related` can't see — escalate to the full suite
    // rather than under-select. Filtered by DEFAULT_IGNORE_PATTERNS only (project-relative
    // `.test-mcp-ignore` semantics don't apply to repo-root-relative outside paths).
    const outsideRelevant = filterChangedPaths(
      unique([...trackedSplit.outside, ...untrackedSplit.outside, ...stagedSplit.outside]),
      [...DEFAULT_IGNORE_PATTERNS],
    );
    if (outsideRelevant.length > 0) return null;
    const untrackedPaths = untrackedSplit.inside;
    const files = unique(filterChangedPaths([...trackedSplit.inside, ...untrackedPaths], patterns));
    const added = unique(
      filterChangedPaths([...untrackedPaths, ...stagedSplit.inside], patterns),
    );
    return { files, added };
  } catch {
    return null;
  }
}

/**
 * ESM/CJS dynamic-import forms a static (git/Vite) module graph can't see through: `import(...)`
 * expressions, and `require(...)` calls whose argument isn't a plain string literal (a literal
 * require is statically resolvable — not a blind spot). POSIX ERE only (no `\b`/`\s`, which are
 * PCRE-only and would need `git grep -P` — not guaranteed available on every git build).
 */
const DYNAMIC_IMPORT_PATTERN = 'import[ \\t]*\\(|require[ \\t]*\\([ \\t]*[^\'"]';

/**
 * Whether any tracked or untracked (non-ignored) file in the project contains dynamic-import
 * syntax. A brand-new unmapped source is only a static-graph blind spot (see `plan`'s
 * `dynamicImportsPresent`) if something reaches it via a dynamic import; when the project has
 * none anywhere, that caveat can't apply. Errs conservative: any git failure (not a repo, git
 * missing) returns true — an unknown answer must never silently drop a real caveat (architecture
 * invariant 5).
 */
export function hasDynamicImportSyntax(projectRoot: string): boolean {
  try {
    // Run from the project dir, not the git root: `git grep` from a subdirectory scopes to that
    // subtree, so a subdir-registered project (e.g. `frontend/`) is not tainted by a sibling
    // (`backend/`) that happens to contain dynamic-import syntax.
    execFileSync(
      "git",
      ["grep", "-I", "--quiet", "--untracked", "--exclude-standard", "-E", DYNAMIC_IMPORT_PATTERN],
      { cwd: projectRoot, stdio: ["ignore", "ignore", "ignore"] },
    );
    return true; // exit 0: at least one match
  } catch (err) {
    // git grep exits 1 for "ran fine, no match" — the one non-conservative case. Anything else
    // (not a repo, git missing, ...) is an unknown answer, so stay conservative and return true.
    return (err as { status?: number }).status !== 1;
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
