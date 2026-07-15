import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestResult, FailureDetail, TestPlan } from "../types/contracts.js";
import { parseFromWorker, type ToWorker, type FromWorker } from "../types/ipc.js";
import { loadCoverageMap } from "../coverage/index.js";
import { SelectionEngine, getChangedFiles } from "../selection/index.js";

/** The minimal project shape the orchestrator needs (matches RegisteredProject). */
export interface ProjectRef {
  projectId: string;
  path: string;
}

/** Error carrying the WorkerFailure code so the MCP layer maps it to the right envelope. */
export class WorkerError extends Error {
  readonly code = "WorkerFailure" as const;
  constructor(message: string) {
    super(message);
    this.name = "WorkerError";
  }
}

/** Error carrying the PlanExpired code (Story 4.1) for the MCP envelope. */
export class PlanError extends Error {
  readonly code = "PlanExpired" as const;
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/** Pollable run state for a project (Story 4.2). */
export interface RunStatus {
  state: "idle" | "running" | "complete" | "error";
  progress?: { completed: number; total: number };
  lastResult?: TestResult;
  lastError?: string;
  updatedAt?: string;
}

/** A completed run retained in the in-memory history ring buffer (for the monitoring UI). */
export interface RunRecord {
  runId: string;
  projectId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "complete" | "error";
  error?: string;
  /** Present for completed runs — carries selection, counts and the failures summary. */
  result?: TestResult;
  /** Full failure detail (stack/diff) for drill-down; empty for error/passing runs. */
  failures: FailureDetail[];
}

/** Concrete, resolved execution parameters plus human-facing selection info. */
interface ResolvedSelection {
  files: string[];
  changed: boolean;
  strategy: "full" | "incremental";
  reason: string;
  /** Nothing to run (e.g. incremental with no changes) — do not dispatch a worker. */
  empty: boolean;
}

interface StoredPlan {
  projectId: string;
  files: string[];
  changed: boolean;
  empty: boolean;
  expiresAtMs: number;
}

type ProgressFn = (completed: number, total: number) => void;

export interface OrchestratorOptions {
  /** Absolute path to the built worker (dist/worker/index.js). Tests inject this. */
  workerPath?: string;
  /** Hard ceiling for a single run before the worker is killed. */
  runTimeoutMs?: number;
  /** How long a dry-run plan stays valid before it must be re-planned (Story 4.1). */
  planTtlMs?: number;
  /** Global ceiling on concurrently-forked workers across all projects (default: unbounded). */
  maxConcurrentWorkers?: number;
}

export class Orchestrator {
  private readonly workerPath: string;
  private readonly runTimeoutMs: number;
  private readonly planTtlMs: number;
  /** Global worker semaphore (architecture: workers bounded by maxConcurrentWorkers). */
  private readonly maxConcurrentWorkers: number;
  private activeWorkers = 0;
  private readonly workerWaiters: Array<() => void> = [];
  /** Per-project promise chain so a project runs one suite at a time (architecture: per-project serialization). */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Most recent run's failure details per project, keyed projectId -> (failureId -> detail). */
  private readonly lastFailures = new Map<string, Map<string, FailureDetail>>();
  /** Dry-run plans awaiting commit (Story 4.1), keyed by planId. */
  private readonly plans = new Map<string, StoredPlan>();
  /** Pollable run state per project (Story 4.2). */
  private readonly runState = new Map<string, RunStatus>();
  /** In-memory run history per project (newest first), capped at maxHistory (UI drill-down). */
  private readonly history = new Map<string, RunRecord[]>();
  private readonly maxHistory = 50;
  /** Status-change subscribers (Story 5.1 UI push). */
  private readonly statusListeners = new Set<() => void>();

  constructor(opts: OrchestratorOptions = {}) {
    // In production this module runs from dist/, so ../worker/index.js resolves to dist/worker/index.js.
    this.workerPath =
      opts.workerPath ?? fileURLToPath(new URL("../worker/index.js", import.meta.url));
    this.runTimeoutMs = opts.runTimeoutMs ?? 120_000;
    this.planTtlMs = opts.planTtlMs ?? 300_000;
    this.maxConcurrentWorkers = Math.max(1, opts.maxConcurrentWorkers ?? Number.POSITIVE_INFINITY);
  }

  /** Acquire a global worker slot, waiting if maxConcurrentWorkers are already busy. */
  private acquireWorker(): Promise<void> {
    if (this.activeWorkers < this.maxConcurrentWorkers) {
      this.activeWorkers++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.workerWaiters.push(resolve));
  }

  /** Release a worker slot, handing it directly to the next waiter if one is queued. */
  private releaseWorker(): void {
    const next = this.workerWaiters.shift();
    if (next) next(); // transfer the slot; activeWorkers stays constant
    else this.activeWorkers--;
  }

  /** Run a project's tests in a fresh project-local worker. Rejects with WorkerError on failure. */
  async runTests(
    project: ProjectRef,
    opts: { files?: string[]; mode?: string; coverage?: boolean; onProgress?: ProgressFn } = {},
  ): Promise<TestResult> {
    const sel = this.resolveSelection(project, opts);
    return this.enqueue(project, sel, opts.coverage === true, opts.onProgress);
  }

  /** Drop plans past their TTL so an uncommitted dry-run can't accumulate forever. */
  private sweepExpiredPlans(): void {
    const now = Date.now();
    for (const [id, p] of this.plans) {
      if (p.expiresAtMs < now) this.plans.delete(id);
    }
  }

  /** Compute a plan without executing (Story 4.1 dry-run). */
  plan(project: ProjectRef, opts: { files?: string[]; mode?: string }): TestPlan {
    this.sweepExpiredPlans();
    const started = Date.now();
    const sel = this.resolveSelection(project, opts);
    const latencyMs = Date.now() - started;
    const planId = randomUUID();
    const expiresAtMs = Date.now() + this.planTtlMs;
    this.plans.set(planId, {
      projectId: project.projectId,
      files: sel.files,
      changed: sel.changed,
      empty: sel.empty,
      expiresAtMs,
    });
    return {
      planId,
      projectId: project.projectId,
      strategy: sel.strategy,
      files: sel.files,
      reasoning: sel.reason,
      createdAt: new Date(started).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      metadata: { latencyMs },
    };
  }

  /** Execute a previously computed plan exactly (Story 4.1 commit). Throws PlanError if expired/unknown. */
  async runPlan(
    project: ProjectRef,
    planId: string,
    opts: { onProgress?: ProgressFn } = {},
  ): Promise<TestResult> {
    this.sweepExpiredPlans();
    const stored = this.plans.get(planId);
    if (!stored || stored.projectId !== project.projectId || stored.expiresAtMs < Date.now()) {
      this.plans.delete(planId);
      throw new PlanError(`Plan ${planId} is expired or unknown; re-plan with dryRun`);
    }
    this.plans.delete(planId); // one-shot commit
    return this.enqueue(
      project,
      {
        files: stored.files,
        changed: stored.changed,
        empty: stored.empty,
        strategy: stored.files.length ? "incremental" : "full",
        reason: "committed plan",
      },
      false,
      opts.onProgress,
    );
  }

  /** Serialize a resolved selection onto the project's queue (short-circuiting empty plans). */
  private enqueue(
    project: ProjectRef,
    sel: ResolvedSelection,
    coverage: boolean,
    onProgress?: ProgressFn,
  ): Promise<TestResult> {
    const prev = this.queues.get(project.projectId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => {
      if (sel.empty) {
        const result = emptyResult(sel.reason);
        const now = new Date().toISOString();
        this.recordRun({
          runId: randomUUID(),
          projectId: project.projectId,
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          status: "complete",
          result,
          failures: [],
        });
        this.setRunState(project.projectId, {
          state: "complete",
          lastResult: result,
          progress: undefined,
        });
        return result;
      }
      return this.execute(project, sel.files, sel.changed, coverage, onProgress);
    });
    // Keep the chain alive even if this run rejects, so the next run still serializes after it.
    this.queues.set(project.projectId, run.catch(() => undefined));
    return run;
  }

  /** Resolve a request into concrete {files, changed} via the Selection Engine (Story 3.5). */
  private resolveSelection(
    project: ProjectRef,
    opts: { files?: string[]; mode?: string },
  ): ResolvedSelection {
    const explicit = opts.files ?? [];
    if (opts.mode === "incremental" && explicit.length === 0) {
      const plan = SelectionEngine.plan({
        changedFiles: getChangedFiles(project.path),
        map: loadCoverageMap(project.path),
      });
      if (plan.strategy === "full") {
        return { files: [], changed: false, strategy: "full", reason: plan.reason, empty: false };
      }
      if (plan.strategy === "changed-only") {
        // worker runs `--changed` with a full-suite fallback (Story 3.1)
        return { files: [], changed: true, strategy: "incremental", reason: plan.reason, empty: false };
      }
      // Nothing to run and no static-graph union requested -> short-circuit (empty filter would be a full run).
      if (plan.testFiles.length === 0 && !plan.union) {
        return { files: [], changed: false, strategy: "incremental", reason: plan.reason, empty: true };
      }
      return {
        files: plan.testFiles,
        changed: plan.union,
        strategy: "incremental",
        reason: plan.reason,
        empty: false,
      };
    }
    if (explicit.length > 0) {
      return {
        files: explicit,
        changed: false,
        strategy: "incremental",
        reason: "explicit file selection",
        empty: false,
      };
    }
    return { files: [], changed: false, strategy: "full", reason: "full suite", empty: false };
  }

  private async execute(
    project: ProjectRef,
    files: string[],
    changed: boolean,
    coverage: boolean,
    onProgress?: ProgressFn,
  ): Promise<TestResult> {
    // Bound total concurrent workers across all projects; release the slot once settled.
    await this.acquireWorker();
    try {
      return await this.executeWorker(project, files, changed, coverage, onProgress);
    } finally {
      this.releaseWorker();
    }
  }

  private executeWorker(
    project: ProjectRef,
    files: string[],
    changed: boolean,
    coverage: boolean,
    onProgress?: ProgressFn,
  ): Promise<TestResult> {
    return new Promise<TestResult>((resolve, reject) => {
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      this.setRunState(project.projectId, {
        state: "running",
        progress: undefined,
        lastError: undefined,
      });
      const failRun = (err: WorkerError): void => {
        this.lastFailures.delete(project.projectId);
        this.recordRun({
          runId,
          projectId: project.projectId,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          status: "error",
          error: err.message,
          failures: [],
        });
        this.setRunState(project.projectId, { state: "error", lastError: err.message, progress: undefined });
        reject(err);
      };
      const workerEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TEST_MCP_STATE_DIR: path.join(project.path, ".test-mcp"),
      };
      if (process.env.TMPDIR) workerEnv.TMPDIR = process.env.TMPDIR;
      if (process.env.LANG) workerEnv.LANG = process.env.LANG;
      if (process.env.TEST_MCP_MEASURE_BUDGET_MS) {
        workerEnv.TEST_MCP_MEASURE_BUDGET_MS = process.env.TEST_MCP_MEASURE_BUDGET_MS;
      }
      const child = fork(this.workerPath, [], {
        cwd: project.path, // worker resolves the project's OWN vitest from here
        execArgv: [], // do not inherit vitest/ts loaders from the parent process
        env: workerEnv,
        // stdout ignored (keep it clean), worker stderr flows to the daemon's stderr.
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });

      let settled = false;
      const timer = setTimeout(() => {
        finish(() => failRun(new WorkerError(`worker timed out after ${this.runTimeoutMs}ms`)));
      }, this.runTimeoutMs);

      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeAllListeners();
        if (!child.killed) child.kill();
        act();
      };

      child.on("message", (raw: unknown) => {
        let msg: FromWorker;
        try {
          msg = parseFromWorker(raw);
        } catch (e) {
          finish(() =>
            failRun(
              new WorkerError(
                `invalid IPC message from worker: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          );
          return;
        }
        if (msg.type === "ready") {
          const runMsg: ToWorker = {
            type: "run",
            runId,
            projectId: project.projectId,
            files,
            coverage,
            allTestsRun: files.length === 0,
            changed,
          };
          if (!child.send(runMsg)) {
            finish(() => failRun(new WorkerError("IPC send failed")));
          }
        } else if (msg.type === "progress" && msg.runId === runId) {
          this.setRunState(project.projectId, {
            state: "running",
            progress: { completed: msg.completed, total: msg.total },
          });
          onProgress?.(msg.completed, msg.total);
        } else if (msg.type === "result" && msg.runId === runId) {
          if (!msg.result) {
            finish(() => failRun(new WorkerError("worker returned no result")));
          } else {
            const failureDetails = msg.failureDetails ?? [];
            const map = new Map<string, FailureDetail>();
            for (const d of failureDetails) map.set(d.id, d);
            this.lastFailures.set(project.projectId, map);
            const result = msg.result;
            this.recordRun({
              runId,
              projectId: project.projectId,
              startedAt,
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              status: "complete",
              result,
              failures: failureDetails,
            });
            this.setRunState(project.projectId, {
              state: "complete",
              lastResult: result,
              progress: undefined,
            });
            finish(() => resolve(result));
          }
        } else if (msg.type === "error" && msg.runId === runId) {
          finish(() => failRun(new WorkerError(msg.message)));
        } else if (
          (msg.type === "result" || msg.type === "error") &&
          msg.runId !== runId
        ) {
          finish(() =>
            failRun(new WorkerError(`unexpected IPC ${msg.type} for run ${runId}`)),
          );
        }
      });

      child.on("error", (err) => finish(() => failRun(new WorkerError(err.message))));
      child.on("exit", (code) =>
        finish(() =>
          failRun(new WorkerError(`worker exited (code ${code}) before returning a result`)),
        ),
      );
    });
  }

  /** Look up a failure from the project's most recent run. */
  getFailureDetail(projectId: string, failureId: string): FailureDetail | undefined {
    return this.lastFailures.get(projectId)?.get(failureId);
  }

  /** Current pollable run state for a project (Story 4.2). */
  getRunStatus(projectId: string): RunStatus {
    return this.runState.get(projectId) ?? { state: "idle" };
  }

  /** Retained run history for a project, newest first (in-memory, capped). */
  getRunHistory(projectId: string): RunRecord[] {
    return this.history.get(projectId) ?? [];
  }

  /** A single retained run by id, or undefined if evicted/unknown. */
  getRun(projectId: string, runId: string): RunRecord | undefined {
    return this.history.get(projectId)?.find((r) => r.runId === runId);
  }

  /** Append a completed run to the project's history ring buffer (newest first, capped). */
  private recordRun(record: RunRecord): void {
    const list = this.history.get(record.projectId) ?? [];
    list.unshift(record);
    if (list.length > this.maxHistory) list.length = this.maxHistory;
    this.history.set(record.projectId, list);
  }

  /** Subscribe to run-state changes (Story 5.1 UI push). Returns an unsubscribe fn. */
  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setRunState(projectId: string, patch: Partial<RunStatus>): void {
    const prev = this.runState.get(projectId) ?? { state: "idle" as const };
    this.runState.set(projectId, { ...prev, ...patch, updatedAt: new Date().toISOString() });
    for (const fn of this.statusListeners) {
      try {
        fn();
      } catch {
        // a broken subscriber must never break a run
      }
    }
  }
}

/** A trivially-successful result for "nothing to run" (e.g. incremental with no changes). */
function emptyResult(reason: string): TestResult {
  return {
    success: true,
    summary: "no tests run (0ms)",
    duration: 0,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    selection: { strategy: "incremental", reason, files: [] },
    metadata: { wallClockMs: 0, testExecMs: 0, overheadMs: 0, isolate: true },
  };
}
