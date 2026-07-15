import { execFileSync } from "node:child_process";
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
  /** The project's coverage map, or null if none has been built. */
  map: CoverageMapFile | null;
}

/** A test file by convention (path- or name-based). Matches the Coverage Engine's rule. */
export function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.split("/").includes("__tests__");
}

export class SelectionEngine {
  static plan(input: SelectionInput): SelectionPlan {
    const { changedFiles, map } = input;

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
    for (const src of changedSources) {
      if (map.fullSuiteTriggers.includes(src)) {
        return { strategy: "full", reason: `changed file is a full-suite trigger: ${src}` };
      }
      const entry = map.map[src];
      if (!entry) {
        // Unknown to the map -> we can't bound the blast radius safely (AC3).
        return { strategy: "full", reason: `changed source unknown to coverage map: ${src}` };
      }
      for (const t of entry.tests) selected.add(t);
    }
    // Unmeasurable tests always run on a relevant (source) change (Story 3.4).
    for (const t of map.alwaysRun) selected.add(t);

    return {
      strategy: "incremental",
      reason: "coverage-map selection unioned with git static-graph",
      testFiles: [...selected].sort(),
      union: true,
    };
  }
}

/**
 * Repo-relative changed files: working tree vs HEAD (tracked) plus untracked files.
 * Returns null when git is unavailable/not a repo so callers fall back to the full suite.
 * Paths are POSIX-style relative to the project root (which is the git root for registered projects).
 */
export function getChangedFiles(projectRoot: string): string[] | null {
  try {
    const gitOpts = {
      cwd: projectRoot,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[],
    };
    const tracked = execFileSync("git", ["diff", "--name-only", "HEAD"], gitOpts);
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], gitOpts);
    const files = [...tracked.split("\n"), ...untracked.split("\n")]
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(path.sep).join("/"));
    return unique(files);
  } catch {
    return null;
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
