import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { filterChangedPaths, loadIgnorePatterns } from "../selection/index.js";

/**
 * Last-run content-hash snapshot (Story 6.7) — the tighter incremental baseline.
 *
 * Incremental selection normally diffs the working tree against git HEAD, so a long
 * uncommitted session keeps growing the changed set and degrades toward full. This
 * module persists a content-hash snapshot of the candidate universe as of the last
 * SUCCESSFUL delta-driven run; `changedSinceSnapshot` then diffs the current contents
 * against it so the changed set is "since last run", matching edit→run→edit→run.
 *
 * Soundness (architecture invariant 5 — never under-select): the snapshot advances
 * ONLY after a successful delta-driven run (whole re-hash), so a changed-but-failed
 * file's hash still differs from the not-advanced snapshot and stays in the next delta.
 * Any uncertainty here (missing/wrong-schema snapshot, git unavailable) returns null so
 * the caller falls back to the git-HEAD baseline (`getChangedFiles`).
 */

export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * On-disk snapshot shape. Validated with Zod on load because it crosses the persistence
 * boundary (CLAUDE.md: validate all external/file input at the edge). `z.record(string, string)`
 * rejects arrays and non-string hash values that a `typeof === "object"` check would let through.
 */
const SnapshotFileSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  takenAt: z.string(),
  files: z.record(z.string(), z.string()),
});

export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

export function snapshotPath(projectRoot: string): string {
  return path.join(projectRoot, ".test-mcp", "last-run-snapshot.json");
}

/**
 * The candidate universe: git-tracked ∪ untracked, POSIX-relative, run through the
 * Story-6.5 ignore filter — the SAME set the changed-set selection considers (staged
 * additions are already in `git ls-files`, i.e. the index). Returns null when git is
 * unavailable / not a repo so callers fall back rather than treat "no files" as "no changes".
 */
export function listCandidateFiles(projectRoot: string): string[] | null {
  try {
    const gitOpts = {
      cwd: projectRoot,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[],
    };
    // `-z` (NUL-delimited) so non-ASCII / spaced paths are emitted raw rather than octal-quoted —
    // a newline+quote split would drop such a file from BOTH the snapshot and the current-tree hash,
    // making its edits invisible to the delta (an under-select — the one non-safe git-parsing edge).
    const tracked = execFileSync("git", ["ls-files", "-z"], gitOpts);
    const untracked = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], gitOpts);
    const normalize = (raw: string): string[] =>
      raw
        .split("\0")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.split(path.sep).join("/"));
    const all = [...normalize(tracked), ...normalize(untracked)];
    return [...new Set(filterChangedPaths(all, loadIgnorePatterns(projectRoot)))];
  } catch {
    return null;
  }
}

/**
 * sha256 (hex) of each file's contents, keyed by POSIX-relative path. An unreadable or
 * absent file is skipped (treated as absent) — the diff then sees it as deleted, never crashes.
 */
export function computeHashes(projectRoot: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of files) {
    try {
      const buf = fs.readFileSync(path.join(projectRoot, rel));
      out[rel] = createHash("sha256").update(buf).digest("hex");
    } catch {
      // Unreadable/absent -> treat as absent (skip); the diff handles it as a deletion.
    }
  }
  return out;
}

/** Load the persisted snapshot, or null if absent/unreadable/wrong schema. */
export function loadSnapshot(projectRoot: string): SnapshotFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(snapshotPath(projectRoot), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = SnapshotFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Persist the snapshot atomically (write then rename) under the project's .test-mcp dir. */
export function saveSnapshot(projectRoot: string, file: SnapshotFile): void {
  const target = snapshotPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Hash the current candidate universe into a snapshot payload (not persisted). Returns null
 * for a non-git project (no meaningful candidate universe) so selection stays on the HEAD/full
 * baseline rather than trusting an empty snapshot.
 */
export function snapshotPayload(projectRoot: string): SnapshotFile | null {
  const files = listCandidateFiles(projectRoot);
  if (files === null) return null;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    takenAt: new Date().toISOString(),
    files: computeHashes(projectRoot, files),
  };
}

/**
 * Hash the current candidate universe and persist it as the last-run snapshot. A non-git project
 * has no candidate universe, so nothing is written (selection stays on the HEAD/full baseline).
 * The orchestrator's run path prefers the selection-time payload (`selectionDelta().pending`);
 * this is the standalone "capture now" helper.
 */
export function writeCurrentSnapshot(projectRoot: string): void {
  const payload = snapshotPayload(projectRoot);
  if (payload === null) return;
  saveSnapshot(projectRoot, payload);
}

/**
 * One hash pass over the candidate universe that yields BOTH the changed-set diff since the
 * last snapshot AND the payload to persist if this run succeeds. Capturing the payload at
 * SELECTION time (rather than re-hashing after the run) is what keeps invariant 5 sound: an
 * edit that lands mid-run is never baselined as "validated" — its selection-time hash is what
 * we persist, so a later edit still differs from it and stays in the next delta.
 *   - `changed.files` = modified (hash differs) ∪ added (absent from snapshot) ∪ deleted (in
 *                       snapshot, absent now); `changed.added` = the newly-present subset.
 *   - `changed` is null when there is no valid snapshot or git is unavailable (caller falls
 *     back to the git-HEAD baseline); `pending` is still populated on the first run so the
 *     first successful run writes the baseline.
 */
export function selectionDelta(projectRoot: string): {
  changed: { files: string[]; added: string[] } | null;
  pending: SnapshotFile | null;
} {
  const candidates = listCandidateFiles(projectRoot);
  if (candidates === null) return { changed: null, pending: null };

  const current = computeHashes(projectRoot, candidates);
  const pending: SnapshotFile = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    takenAt: new Date().toISOString(),
    files: current,
  };

  const snapshot = loadSnapshot(projectRoot);
  if (!snapshot) return { changed: null, pending };

  const files = new Set<string>();
  const added = new Set<string>();
  for (const [rel, hash] of Object.entries(current)) {
    const prev = snapshot.files[rel];
    if (prev === undefined) {
      files.add(rel);
      added.add(rel);
    } else if (prev !== hash) {
      files.add(rel);
    }
  }
  for (const rel of Object.keys(snapshot.files)) {
    if (current[rel] === undefined) files.add(rel);
  }

  return { changed: { files: [...files].sort(), added: [...added].sort() }, pending };
}

/**
 * The changed set since the last snapshot, in the same `{ files, added }` shape as
 * `getChangedFiles` so `plan()` and the Story-6.6 new-vs-modified logic work unchanged.
 * Returns null when there is no valid snapshot or git is unavailable — the caller then
 * falls back to the git-HEAD baseline (never under-select).
 */
export function changedSinceSnapshot(
  projectRoot: string,
): { files: string[]; added: string[] } | null {
  return selectionDelta(projectRoot).changed;
}
