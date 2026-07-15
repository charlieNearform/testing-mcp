import * as fs from "node:fs";
import * as path from "node:path";
import type { RunRecord } from "../orchestrator/index.js";

/**
 * On-disk run-history persistence (Story 6.2). The orchestrator keeps a capped in-memory ring
 * buffer of recent runs; this module mirrors each record to
 * `<git-root>/.test-mcp/history/<runId>.json` (atomic write) so history survives a daemon restart,
 * prunes the oldest files past the cap, and rehydrates the buffer on startup.
 *
 * `.test-mcp/` is git-ignored by `register`/`init`, so these records never enter version control.
 * Any per-file corruption is skipped (logged to stderr) — never crash the daemon (invariant).
 */

export const HISTORY_SCHEMA_VERSION = 1;

export function historyDir(projectPath: string): string {
  return path.join(projectPath, ".test-mcp", "history");
}

/** Persist one run record atomically (temp file + rename), wrapped with a `schemaVersion`. */
export function writeRunRecord(projectPath: string, record: RunRecord): void {
  const dir = historyDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  // basename the runId defensively — records are keyed by a daemon-generated UUID today, but a
  // path separator here must never let a write escape the history dir.
  const target = path.join(dir, path.basename(`${record.runId}.json`));
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, ...record }, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Delete on-disk records beyond `cap`, oldest first, so the dir stays bounded. Ordering is by the
 * record's own `finishedAt` (same key as `loadHistory`, so prune and load agree) with a stable
 * `name` tiebreak — the just-written record (newest `finishedAt`) is therefore never the one pruned
 * even when several runs land in the same millisecond. Also sweeps leftover `*.tmp` files from any
 * crash mid-write, which the `.json` filters would otherwise let accumulate forever.
 */
export function pruneHistory(projectPath: string, cap: number): void {
  const dir = historyDir(projectPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // no dir yet -> nothing to prune
  }
  for (const n of names) {
    if (n.endsWith(".tmp")) {
      try {
        fs.rmSync(path.join(dir, n), { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
  const jsonNames = names.filter((n) => n.endsWith(".json"));
  if (jsonNames.length <= cap) return;
  const sortable = jsonNames.map((name) => {
    const full = path.join(dir, name);
    let finishedAt = "";
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { finishedAt?: string };
      if (typeof parsed.finishedAt === "string") finishedAt = parsed.finishedAt;
    } catch {
      // unreadable/corrupt -> empty finishedAt sorts oldest -> a prune candidate
    }
    return { full, name, finishedAt };
  });
  sortable.sort((a, b) => byFinishedThenId(a, b)); // newest first
  for (const { full } of sortable.slice(cap)) {
    try {
      fs.rmSync(full, { force: true });
    } catch {
      // best-effort prune; a failure here must never break a run
    }
  }
}

/** Newest-first by `finishedAt`, tiebroken by id/name so ordering is deterministic across reloads. */
function byFinishedThenId(
  a: { finishedAt: string; name?: string; runId?: string },
  b: { finishedAt: string; name?: string; runId?: string },
): number {
  if (a.finishedAt !== b.finishedAt) return a.finishedAt < b.finishedAt ? 1 : -1;
  const ai = a.name ?? a.runId ?? "";
  const bi = b.name ?? b.runId ?? "";
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/**
 * Rehydrate up to `cap` most-recent run records (by `finishedAt`) from disk. Files that are
 * unreadable, non-JSON, missing a `runId`, or carry a missing/unrecognized `schemaVersion` are
 * skipped with a stderr warning rather than aborting the load.
 */
export function loadHistory(projectPath: string, cap: number): RunRecord[] {
  const dir = historyDir(projectPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return []; // no history dir -> empty (first run of a fresh project)
  }
  const records: RunRecord[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as
        | (Partial<RunRecord> & { schemaVersion?: number })
        | null;
      // Require the fields we sort/serve on so a partial/hand-edited file can't land at an
      // arbitrary sort position or be served as a real run.
      if (
        parsed?.schemaVersion !== HISTORY_SCHEMA_VERSION ||
        typeof parsed.runId !== "string" ||
        typeof parsed.finishedAt !== "string" ||
        parsed.finishedAt.length === 0
      ) {
        process.stderr.write(`[test-mcp] skipping unrecognized history file: ${full}\n`);
        continue;
      }
      const { schemaVersion: _schemaVersion, ...record } = parsed;
      records.push(record as RunRecord);
    } catch (err) {
      process.stderr.write(
        `[test-mcp] skipping corrupt history file ${full}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }
  // Newest first (deterministic tiebreak), capped to the same limit as the in-memory buffer.
  records.sort((a, b) => byFinishedThenId(a, b));
  return records.slice(0, cap);
}
