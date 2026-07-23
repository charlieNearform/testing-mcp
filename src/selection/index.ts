import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CoverageMapFile } from "../coverage/index.js";
import type { Confidence } from "../types/contracts.js";

export type { Confidence };

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
  | { strategy: "full"; reason: string; confidence: Confidence }
  /** No map yet: defer to the worker's git `--changed` pass (Story 3.1). */
  | { strategy: "changed-only"; reason: string; confidence: Confidence }
  | {
      strategy: "incremental";
      reason: string;
      testFiles: string[];
      union: boolean;
      confidence: Confidence;
    };

export interface SelectionInput {
  /** Repo-relative changed files (working tree vs HEAD, incl. untracked); null if undeterminable. */
  changedFiles: string[] | null;
  /**
   * Repo-relative NEW (untracked) subset of `changedFiles` (Story 6.6). A new source unknown
   * to the map has no prior runtime dependents, so the git static-graph union (`--changed`)
   * bounds it — flagged `degraded` (Story 6.8) rather than forcing a full suite.
   */
  addedFiles?: string[];
  /** The project's coverage map, or null if none has been built. */
  map: CoverageMapFile | null;
  /**
   * Opt-out (Story 6.8, AC5): restore the old force-full-on-uncertainty behaviour. When true, a
   * source unknown to the map forces the full suite instead of a bounded+degraded incremental run.
   */
  strict?: boolean;
  /**
   * Whether the project has any dynamic-import syntax at all (`hasDynamicImportSyntax`). A NEW
   * unmapped source is only a static-graph blind spot if something reaches it via a dynamic
   * import; when the project has none anywhere, that specific caveat doesn't apply. Undefined
   * (caller didn't check) is treated as "might have one" — conservative, matching prior behaviour.
   */
  dynamicImportsPresent?: boolean;
  /**
   * Total distinct test files in the project's known inventory (size-based full-run escalation),
   * or 0/undefined when there is no inventory yet. Only ever consulted on the final auto-computed
   * incremental path (never for `changed-only`, `full`, or the empty short-circuit) so a caller
   * with no denominator, or one that already resolved a different strategy, is unaffected.
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

/** Same env-configurable-numeric convention as `TEST_MCP_MEASURE_BUDGET_MS`/
 *  `TEST_MCP_FULL_COVERAGE_BUDGET_MS` (src/worker/index.ts), but additionally range-checked: a
 *  fraction must be `(0, 1]` to mean anything as "a fraction of the suite." Unlike a plain
 *  `Number.isFinite` guard (which does NOT catch this), an accidentally-blank env value
 *  (`Number("") === 0`, finite) would otherwise silently make EVERY incremental selection
 *  escalate to full — inverting the whole feature rather than falling back to the default as
 *  intended. A value `<= 0` or `> 1` is equally nonsensical (always-escalate / never-escalate)
 *  and gets the same fallback. Found via adversarial review, not anticipated originally. */
function getIncrementalFullThreshold(): number {
  const raw = Number(
    process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD ?? DEFAULT_INCREMENTAL_FULL_THRESHOLD,
  );
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_INCREMENTAL_FULL_THRESHOLD;
}

/** A test file by convention (path- or name-based). Matches the Coverage Engine's rule. */
export function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.split("/").includes("__tests__");
}

export class SelectionEngine {
  static plan(input: SelectionInput): SelectionPlan {
    const { changedFiles, addedFiles, map, strict, dynamicImportsPresent, totalTestFileCount } = input;
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
        testFiles: [],
        union: false,
        confidence: HIGH,
      };
    }

    const changedTests = changedFiles.filter(isTestFile);
    const changedSources = changedFiles.filter((f) => !isTestFile(f));

    // Only test files changed -> run exactly those (AC1): provably complete.
    if (changedSources.length === 0) {
      return {
        strategy: "incremental",
        reason: "only test files changed",
        testFiles: unique(changedTests),
        union: false,
        confidence: HIGH,
      };
    }

    // Source files changed but no map yet. `strict` (AC5) wants force-full on ANY unmapped-source
    // uncertainty — and "no map at all" is the maximal such case — so honour it here too. Otherwise
    // defer to the git static-graph pass (Story 3.1); we can't confirm the static graph catches
    // every dependent (dynamic imports are invisible), so the run is degraded.
    if (!map) {
      if (strict) {
        return {
          strategy: "full",
          reason: "source changed; no coverage map (strict)",
          confidence: HIGH,
        };
      }
      return {
        strategy: "changed-only",
        reason: "source changed; no coverage map yet — using git static-graph",
        confidence: degraded(["no coverage map yet — relying on the git static import graph"]),
      };
    }

    // Source files changed WITH a map -> map selection, unioned with the static graph at run time
    // ONLY when some changed source is unmapped (the map has nothing to say about it, so the
    // static graph is the sole signal — not a redundant safety net).
    const selected = new Set<string>(changedTests);
    const reasons: string[] = [];
    let unmappedSourceSeen = false;
    for (const src of changedSources) {
      if (map.fullSuiteTriggers.includes(src)) {
        // A full run IS complete -> high, regardless of any other changed file.
        return {
          strategy: "full",
          reason: `changed file is a full-suite trigger: ${src}`,
          confidence: HIGH,
        };
      }
      const entry = map.map[src];
      if (!entry) {
        unmappedSourceSeen = true;
        // Unknown to the map. `strict` (AC5) restores the old force-full behaviour. Otherwise the
        // `union: true` git static-graph pass (`--changed`) bounds it — a NEW source has no prior
        // runtime dependents (Story 6.6); a MODIFIED/DELETED one is softened from full to bounded
        // (Story 6.8). Either way we can't prove the static graph caught every dependent (dynamic
        // imports are invisible), so we flag the run degraded and name the file.
        if (strict) {
          return {
            strategy: "full",
            reason: `changed source unknown to coverage map: ${src} (strict)`,
            confidence: HIGH,
          };
        }
        if (addedFiles?.includes(src)) {
          // A brand-new file has no prior runtime dependents (Story 6.6); the --changed union
          // only misses it if something reaches it via a dynamic import the static graph can't
          // see. When the project has no dynamic-import syntax anywhere (checked by the caller),
          // that risk doesn't exist, so this source is fully covered — nothing to flag.
          if (mightMissDynamicImport) {
            reasons.push(`new source bounded by the git static graph (dynamic imports may be missed): ${src}`);
          }
        } else {
          reasons.push(`modified or deleted source not in the coverage map, bounded by the git static graph: ${src}`);
        }
        continue;
      }
      for (const t of entry.tests) selected.add(t);
    }
    // Unmeasurable tests always run on a relevant (source) change (Story 3.4). They are force-run,
    // so they do not reduce confidence — running them all IS complete coverage for them.
    for (const t of map.alwaysRun) selected.add(t);

    // That static-graph pass is always HEAD-scoped (Story 6.7's static-graph-interplay note), so
    // running it when every changed source is already mapped would silently widen a
    // `since: "last-run"` request back out to "everything uncommitted since HEAD" for no benefit —
    // a fully-mapped, re-measured selection is already provably complete (Story 6.8 AC1).
    const union = unmappedSourceSeen;
    // Size-based full-run escalation: only reachable from this auto-computed path (never from
    // `changed-only`/`full`/the empty short-circuit above, nor from the explicit `files:[...]`
    // caller in resolveSelection, which never calls plan() at all). A zero/undefined denominator
    // (no inventory yet) must never divide-by-zero into a false "full" — skip the check entirely.
    if (totalTestFileCount) {
      const fraction = selected.size / totalTestFileCount;
      if (fraction > getIncrementalFullThreshold()) {
        // Clamped to 100 -- `selected.size` can exceed `totalTestFileCount` (a just-added test
        // file the inventory hasn't reconciled yet is still a real, valid selection target), and
        // an uncapped percentage would read as a nonsensical "150% of the suite." The raw
        // numerator/denominator are still reported alongside it, so nothing is hidden.
        const pct = Math.min(100, Math.round(fraction * 100));
        return {
          strategy: "full",
          // A full run IS complete regardless of why it was chosen -> high, same as any other
          // full-suite decision above.
          reason: `incremental selection would run ${pct}% of the suite (${selected.size}/${totalTestFileCount} test files); running full for speed`,
          confidence: HIGH,
        };
      }
    }
    return {
      strategy: "incremental",
      reason: !union
        ? "coverage-map selection (all changed sources mapped and re-measured)"
        : reasons.length
          ? "coverage-map selection unioned with git static-graph (unmapped changes bounded by --changed)"
          : "coverage-map selection unioned with git static-graph",
      testFiles: [...selected].sort(),
      union,
      confidence: reasons.length ? degraded(reasons) : HIGH,
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
    const normalize = (raw: string): string[] =>
      raw
        .split("\0")
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
