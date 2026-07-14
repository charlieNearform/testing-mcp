import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestResult, FailureDetail } from "../types/contracts.js";
import type { ToWorker, FromWorker } from "../types/ipc.js";

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
  async runTests(project: ProjectRef, opts: { files?: string[] } = {}): Promise<TestResult> {
    const prev = this.queues.get(project.projectId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.execute(project, opts.files ?? []));
    // Keep the chain alive even if this run rejects, so the next run still serializes after it.
    this.queues.set(project.projectId, run.catch(() => undefined));
    return run;
  }

  private execute(project: ProjectRef, files: string[]): Promise<TestResult> {
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
            files,
            coverage: false,
            allTestsRun: files.length === 0,
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
