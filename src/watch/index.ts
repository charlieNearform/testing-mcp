import * as fs from "node:fs";
import * as path from "node:path";
import type { Orchestrator, ProjectRef } from "../orchestrator/index.js";
import type { TestResult } from "../types/contracts.js";

/**
 * Watch / incremental mode (Story 3.6). A daemon-side, long-lived file watcher per
 * project: on a debounced filesystem change it re-runs the affected tests via the
 * Selection Engine (through Orchestrator.runTests incremental) and caches the latest
 * result. MCP is request/response, so watch does NOT stream — agents poll
 * `get_test_status` for the latest state (true push is reserved for the Layer-2 UI).
 */

export type WatchState = "idle" | "running" | "complete" | "error";

export interface WatchStatus {
  watching: boolean;
  state: WatchState;
  runsCompleted: number;
  fastMode?: boolean;
  lastError?: string;
  lastResult?: TestResult;
}

interface Session {
  watcher: fs.FSWatcher;
  state: WatchState;
  runsCompleted: number;
  /** A change arrived while a run was in flight — run once more when it settles. */
  pending: boolean;
  debounce?: NodeJS.Timeout;
  /** When false, runs collect coverage alongside tests (refreshing the map). */
  fastMode: boolean;
  lastResult?: TestResult;
  lastError?: string;
}

/** Directory names whose changes never warrant a re-run. */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".test-mcp", "dist", "coverage", ".vitest-reports"]);
const DEBOUNCE_MS = 300;

export class WatchManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly orchestrator: Orchestrator) {}

  isWatching(projectId: string): boolean {
    return this.sessions.has(projectId);
  }

  /** Start watching a project (idempotent). `fastMode` (default true) skips coverage for speed. */
  start(project: ProjectRef, opts: { fastMode?: boolean } = {}): WatchStatus {
    const existing = this.sessions.get(project.projectId);
    if (existing) return this.status(project.projectId);

    const watcher = fs.watch(project.path, { recursive: true }, (_event, filename) => {
      if (filename && this.isIgnored(filename.toString())) return;
      this.schedule(project);
    });
    this.sessions.set(project.projectId, {
      watcher,
      state: "idle",
      runsCompleted: 0,
      pending: false,
      fastMode: opts.fastMode !== false,
    });
    return this.status(project.projectId);
  }

  /** Stop watching a project. Returns false if it wasn't being watched. */
  stop(projectId: string): boolean {
    const s = this.sessions.get(projectId);
    if (!s) return false;
    if (s.debounce) clearTimeout(s.debounce);
    s.watcher.close();
    this.sessions.delete(projectId);
    return true;
  }

  status(projectId: string): WatchStatus {
    const s = this.sessions.get(projectId);
    if (!s) return { watching: false, state: "idle", runsCompleted: 0 };
    return {
      watching: true,
      state: s.state,
      runsCompleted: s.runsCompleted,
      fastMode: s.fastMode,
      lastError: s.lastError,
      lastResult: s.lastResult,
    };
  }

  /** Stop every session (daemon shutdown). */
  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  private isIgnored(filename: string): boolean {
    return filename.split(path.sep).some((seg) => IGNORED_DIRS.has(seg));
  }

  private schedule(project: ProjectRef): void {
    const s = this.sessions.get(project.projectId);
    if (!s) return;
    if (s.debounce) clearTimeout(s.debounce);
    s.debounce = setTimeout(() => this.trigger(project), DEBOUNCE_MS);
  }

  private trigger(project: ProjectRef): void {
    const s = this.sessions.get(project.projectId);
    if (!s) return;
    if (s.state === "running") {
      s.pending = true; // coalesce; re-run after the current one finishes
      return;
    }
    this.runOnce(project, s);
  }

  private runOnce(project: ProjectRef, s: Session): void {
    s.state = "running";
    s.pending = false;
    this.orchestrator
      .runTests(project, { mode: "incremental", coverage: !s.fastMode })
      .then((result) => {
        s.lastResult = result;
        s.lastError = undefined;
        s.state = "complete";
      })
      .catch((err: unknown) => {
        s.lastError = err instanceof Error ? err.message : String(err);
        s.state = "error";
      })
      .finally(() => {
        s.runsCompleted++;
        // Only continue if the session is still active and changes arrived mid-run.
        if (this.sessions.get(project.projectId) === s && s.pending) this.runOnce(project, s);
      });
  }
}
