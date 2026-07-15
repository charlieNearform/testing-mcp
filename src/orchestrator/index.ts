import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestResult, FailureDetail } from "../types/contracts.js";
import type { ToWorker, FromWorker } from "../types/ipc.js";
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

export interface OrchestratorOptions {
  /** Absolute path to the built worker (dist/worker/index.js). Tests inject this. */
  workerPath?: string;
  /** Hard ceiling for a single run before the worker is killed. */
  runTimeoutMs?: number;
}

export class Orchestrator {
  private readonly workerPath: string;
  private readonly runTimeoutMs: number;
  /** Per-project promise chain so a project runs one suite at a time (architecture: per-project serialization). */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Most recent run's failure details per project, keyed projectId -> (failureId -> detail). */
  private readonly lastFailures = new Map<string, Map<string, FailureDetail>>();

  constructor(opts: OrchestratorOptions = {}) {
    // In production this module runs from dist/, so ../worker/index.js resolves to dist/worker/index.js.
    this.workerPath =
      opts.workerPath ?? fileURLToPath(new URL("../worker/index.js", import.meta.url));
    this.runTimeoutMs = opts.runTimeoutMs ?? 120_000;
  }

  /** Run a project's tests in a fresh project-local worker. Rejects with WorkerError on failure. */
  async runTests(
    project: ProjectRef,
    opts: { files?: string[]; mode?: string; coverage?: boolean } = {},
  ): Promise<TestResult> {
    const prev = this.queues.get(project.projectId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.planAndExecute(project, opts));
    // Keep the chain alive even if this run rejects, so the next run still serializes after it.
    this.queues.set(project.projectId, run.catch(() => undefined));
    return run;
  }

  /** Resolve an incremental request into a concrete worker run via the Selection Engine (Story 3.5). */
  private planAndExecute(
    project: ProjectRef,
    opts: { files?: string[]; mode?: string; coverage?: boolean },
  ): Promise<TestResult> {
    let files = opts.files ?? [];
    let changed = false;

    // Selection only applies to an incremental request with no explicit file list.
    if (opts.mode === "incremental" && files.length === 0) {
      const plan = SelectionEngine.plan({
        changedFiles: getChangedFiles(project.path),
        map: loadCoverageMap(project.path),
      });
      if (plan.strategy === "full") {
        files = [];
        changed = false;
      } else if (plan.strategy === "changed-only") {
        files = [];
        changed = true; // worker runs `--changed` with a full-suite fallback (Story 3.1)
      } else {
        // Nothing to run and no static-graph union requested -> short-circuit (no empty-filter = full).
        if (plan.testFiles.length === 0 && !plan.union) {
          return Promise.resolve(emptyResult(plan.reason));
        }
        files = plan.testFiles;
        changed = plan.union;
      }
    }

    return this.execute(project, files, changed, opts.coverage === true);
  }

  private execute(
    project: ProjectRef,
    files: string[],
    changed: boolean,
    coverage: boolean,
  ): Promise<TestResult> {
    return new Promise<TestResult>((resolve, reject) => {
      const runId = randomUUID();
      const failRun = (err: WorkerError): void => {
        this.lastFailures.delete(project.projectId);
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

      child.on("message", (msg: FromWorker) => {
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
        } else if (msg.type === "result" && msg.runId === runId) {
          if (!msg.result) {
            finish(() => failRun(new WorkerError("worker returned no result")));
          } else {
            const map = new Map<string, FailureDetail>();
            for (const d of msg.failureDetails ?? []) map.set(d.id, d);
            this.lastFailures.set(project.projectId, map);
            finish(() => resolve(msg.result));
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
}

/** A trivially-successful result for "nothing to run" (e.g. incremental with no changes). */
function emptyResult(reason: string): TestResult {
  return {
    success: true,
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
