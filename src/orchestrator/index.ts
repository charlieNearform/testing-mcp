import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { TestResult, FailureDetail, TestPlan } from "../types/contracts.js";
import { parseFromWorker, type ToWorker, type FromWorker } from "../types/ipc.js";
import { loadCoverageMap } from "../coverage/index.js";
import {
  SelectionEngine,
  getChangedFiles,
  hasDynamicImportSyntax,
  type Confidence,
} from "../selection/index.js";
import {
  selectionDelta,
  snapshotPayload,
  saveSnapshot,
  type SnapshotFile,
} from "../snapshot/index.js";
import {
  writeRunRecord,
  pruneHistory,
  loadHistory as loadHistoryFromDisk,
  loadTestInventory as loadTestInventoryFromDisk,
  saveTestInventory,
  type TestInventory,
} from "../history/index.js";

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
  /** The run this status reflects (Story 8.4) — set when a run starts, kept through settle. */
  runId?: string;
}

/** A single test's live status while its run is in flight (Story 8.5). */
export interface LiveTestEntry {
  file: string;
  name: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
}

/** One line of a live run's captured console output (Story 8.5). */
export interface LiveLogLine {
  stream: "stdout" | "stderr";
  text: string;
  at: string;
}

/** Coverage-phase heartbeat surfaced identically to test-level progress (AD-20/AD-21). */
export interface LivePhase {
  phase: "coverage";
  completed: number;
  total: number;
}

/** Bounded, transient, in-flight-only view of one project's current/most-recent run (Story 8.5). */
interface LiveRunState {
  runId: string;
  testTimeoutMs?: number;
  lastProgressAt: number;
  tests: Map<string, LiveTestEntry>;
  testOrder: string[];
  testsTruncated: boolean;
  log: LiveLogLine[];
  stdoutResidual: string;
  stderrResidual: string;
  phase?: LivePhase;
}

const MAX_LIVE_TEST_ENTRIES = 2000;
const MAX_LOG_LINES = 1000;
const MAX_LOG_LINE_CHARS = 4000;
const MAX_RESIDUAL_CHARS = 8000;
const MIN_SANE_TEST_TIMEOUT_MS = 1_000;
/** A `testTimeout` this large almost certainly means the watchdog was meant to be disabled, not
 *  that a real per-test timeout is actually that long -- cap it so a huge/misconfigured value
 *  can't silently defeat stall detection. */
const MAX_SANE_TEST_TIMEOUT_MS = 30 * 60_000;
/**
 * Fallback effective test timeout once the worker has said SOMETHING (any message) but no real
 * `testTimeout` is known yet -- Vitest's own documented default `testTimeout` (5000ms), not an
 * arbitrary guess, since that's what actually applies when a project doesn't override it.
 */
const DEFAULT_UNKNOWN_TEST_TIMEOUT_MS = 5_000;
/** Key for LiveTestEntry map entries — a test is identified by (file, name), not by name alone. */
const liveTestKey = (file: string, name: string): string => `${file}\0${name}`;

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
  /**
   * True when this selection came from the incremental delta path (mode incremental, no explicit
   * files) — the only kind of run that may advance the last-run snapshot on success (Story 6.7).
   * Explicit-files and plain full runs never advance it.
   */
  deltaDriven: boolean;
  /**
   * The candidate-universe snapshot captured at SELECTION time (Story 6.7). Persisted verbatim
   * if this delta-driven run succeeds — never re-hashed post-run — so an edit landing mid-run is
   * never baselined as validated (invariant 5). Undefined for non-delta / non-git runs.
   */
  pendingSnapshot?: SnapshotFile | null;
  /** Selection confidence verdict (Story 6.8), attached to the returned TestResult. */
  confidence: Confidence;
}

interface StoredPlan {
  projectId: string;
  files: string[];
  changed: boolean;
  empty: boolean;
  expiresAtMs: number;
  confidence: Confidence;
}

type ProgressFn = (completed: number, total: number) => void;

export interface OrchestratorOptions {
  /** Absolute path to the built worker (dist/worker/index.js). Tests inject this. */
  workerPath?: string;
  /** Hard ceiling for a single run before the worker is killed. Unset = no cap (default). */
  runTimeoutMs?: number;
  /** How long a dry-run plan stays valid before it must be re-planned (Story 4.1). */
  planTtlMs?: number;
  /** Global ceiling on concurrently-forked workers across all projects (default: unbounded). */
  maxConcurrentWorkers?: number;
  /**
   * Grace period (ms) added to a project's resolved testTimeout for the stall watchdog (Story
   * 8.5) — on by default, unlike runTimeoutMs, since it targets a genuine hang, not a cap on a
   * legitimately long run.
   */
  staleTestGraceMs?: number;
}

export class Orchestrator {
  private readonly workerPath: string;
  /** Undefined means no cap: a real suite can legitimately run 15-20+ minutes. */
  private readonly runTimeoutMs: number | undefined;
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
  /**
   * Per-project test inventory: file -> the set of test names last seen in it (test-count-accuracy
   * fix). This is the source of truth for "total tests" — unlike the capped history ring buffer,
   * it never shrinks as old runs age out, and it self-heals deletions the next time a file re-runs.
   */
  private readonly testInventory = new Map<string, Map<string, Set<string>>>();
  /** Bounded, transient live view of each project's current/most-recent run (Story 8.5). */
  private readonly liveRuns = new Map<string, LiveRunState>();
  /** Stall-watchdog grace period, added to a project's resolved testTimeout (Story 8.5). */
  private readonly staleTestGraceMs: number;
  /** Status-change subscribers (Story 5.1 UI push). */
  private readonly statusListeners = new Set<() => void>();

  constructor(opts: OrchestratorOptions = {}) {
    // In production this module runs from dist/, so ../worker/index.js resolves to dist/worker/index.js.
    this.workerPath =
      opts.workerPath ?? fileURLToPath(new URL("../worker/index.js", import.meta.url));
    // No default cap: an operator opts in via DaemonConfig.runTimeoutMs (src/daemon/index.ts).
    this.runTimeoutMs = opts.runTimeoutMs;
    this.planTtlMs = opts.planTtlMs ?? 300_000;
    this.maxConcurrentWorkers = Math.max(1, opts.maxConcurrentWorkers ?? Number.POSITIVE_INFINITY);
    this.staleTestGraceMs = opts.staleTestGraceMs ?? 5000;
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
    opts: {
      files?: string[];
      mode?: string;
      /**
       * Explicit override. When omitted on a FULL-SUITE run, defaults to whether the project
       * already has a coverage map: "opt out" (pass `false`) once coverage has been enabled for
       * a project, "opt in" (off) until it has — a project that has never proven coverage works
       * there isn't forced into an unmeasured attempt on every run. On an incremental/selective
       * run, omitted always means `false` regardless of whether a map exists (Story 3.7 AC4) —
       * a full-suite run's coverage is now one cheap native Vitest pass, so auto-enabling it
       * there costs little; auto-enabling it on a fast, in-loop selective run would silently
       * re-trigger the (still real, if bounded) per-file measurement cost that story is meant to
       * avoid during iterative development.
       */
      coverage?: boolean;
      /** Incremental baseline: "last-run" (default, hash-diff vs snapshot) or "head" (git HEAD). */
      since?: "last-run" | "head";
      /** Opt-out (Story 6.8): force full on any unmapped-source uncertainty (old behaviour). */
      strict?: boolean;
      onProgress?: ProgressFn;
    } = {},
  ): Promise<TestResult> {
    const { result } = this.startRun(project, opts);
    return result;
  }

  /**
   * Start a run and return its id immediately, before the run settles (Story 8.4). `result`
   * resolves/rejects exactly like `runTests()` always has -- this is the mechanism that makes
   * an async, job-handle-returning `run_tests` MCP call possible (Story 8.6) without changing
   * anything about how the run itself executes.
   */
  startRun(
    project: ProjectRef,
    opts: {
      files?: string[];
      mode?: string;
      coverage?: boolean;
      since?: "last-run" | "head";
      strict?: boolean;
      onProgress?: ProgressFn;
    } = {},
  ): { runId: string; result: Promise<TestResult> } {
    const runId = randomUUID();
    const sel = this.resolveSelection(project, opts);
    // The map-exists auto-default only applies to a genuine full-suite run (Story 3.7 AC4) --
    // any other resolved strategy (incremental/changed-only) defaults to `false` when omitted.
    const coverage = opts.coverage ?? (sel.strategy === "full" && loadCoverageMap(project.path) !== null);
    const result = this.enqueue(project, sel, coverage, runId, opts.onProgress);
    return { runId, result };
  }

  /** Drop plans past their TTL so an uncommitted dry-run can't accumulate forever. */
  private sweepExpiredPlans(): void {
    const now = Date.now();
    for (const [id, p] of this.plans) {
      if (p.expiresAtMs < now) this.plans.delete(id);
    }
  }

  /** Compute a plan without executing (Story 4.1 dry-run). */
  plan(
    project: ProjectRef,
    opts: { files?: string[]; mode?: string; since?: "last-run" | "head"; strict?: boolean },
  ): TestPlan {
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
      confidence: sel.confidence,
    });
    return {
      planId,
      projectId: project.projectId,
      strategy: sel.strategy,
      files: sel.files,
      reasoning: sel.reason,
      confidence: sel.confidence,
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
    const { result } = this.startPlanRun(project, planId, opts);
    return result;
  }

  /**
   * `startRun`'s counterpart for a committed plan (Story 8.4) — same {runId, result} shape, so
   * `run_tests`'s async job-handle path (Story 8.6) works identically whether the call came with
   * a `planId` or not. Plan validation is synchronous and still throws PlanError immediately for
   * an expired/unknown plan (no run, no runId to hand back) -- unchanged from `runPlan`'s prior
   * behavior.
   */
  startPlanRun(
    project: ProjectRef,
    planId: string,
    opts: { onProgress?: ProgressFn } = {},
  ): { runId: string; result: Promise<TestResult> } {
    this.sweepExpiredPlans();
    const stored = this.plans.get(planId);
    if (!stored || stored.projectId !== project.projectId || stored.expiresAtMs < Date.now()) {
      this.plans.delete(planId);
      throw new PlanError(`Plan ${planId} is expired or unknown; re-plan with dryRun`);
    }
    this.plans.delete(planId); // one-shot commit
    const runId = randomUUID();
    const result = this.enqueue(
      project,
      {
        files: stored.files,
        changed: stored.changed,
        empty: stored.empty,
        // A changed-only plan has empty `files` but still runs incrementally (git --changed),
        // so derive from `changed` too — not `files.length` alone — or the result would be
        // mislabelled "full" while running a bounded set.
        strategy: stored.changed || stored.files.length ? "incremental" : "full",
        reason: "committed plan",
        // A committed plan replays a frozen selection; conservatively it does not advance the
        // last-run snapshot (never under-selects — the snapshot just stays on its prior baseline).
        deltaDriven: false,
        confidence: stored.confidence,
      },
      false,
      runId,
      opts.onProgress,
    );
    return { runId, result };
  }

  /** Serialize a resolved selection onto the project's queue (short-circuiting empty plans). */
  private enqueue(
    project: ProjectRef,
    sel: ResolvedSelection,
    coverage: boolean,
    runId: string,
    onProgress?: ProgressFn,
  ): Promise<TestResult> {
    const prev = this.queues.get(project.projectId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => {
      if (sel.empty) {
        const result = emptyResult(sel.reason);
        result.confidence = sel.confidence;
        const now = new Date().toISOString();
        // This run never forks a worker, so nothing else creates a fresh live-state entry for it
        // -- without this, getLiveRun() would keep returning a stale PREVIOUS run's tests/log
        // under a runId that doesn't match this (empty) run's own runId.
        this.liveRuns.set(project.projectId, {
          runId,
          lastProgressAt: Date.now(),
          tests: new Map(),
          testOrder: [],
          testsTruncated: false,
          log: [],
          stdoutResidual: "",
          stderrResidual: "",
        });
        this.advanceSnapshotIfDeltaRun(project, sel, result);
        this.recordRun({
          runId,
          projectId: project.projectId,
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          status: "complete",
          result,
          failures: [],
        }, project.path);
        this.setRunState(project.projectId, {
          state: "complete",
          lastResult: result,
          progress: undefined,
          runId,
        });
        return result;
      }
      return this.execute(project, sel, coverage, runId, onProgress);
    });
    // Keep the chain alive even if this run rejects, so the next run still serializes after it.
    this.queues.set(project.projectId, run.catch(() => undefined));
    return run;
  }

  /** Resolve a request into concrete {files, changed} via the Selection Engine (Story 3.5). */
  private resolveSelection(
    project: ProjectRef,
    opts: { files?: string[]; mode?: string; since?: "last-run" | "head"; strict?: boolean },
  ): ResolvedSelection {
    const explicit = opts.files ?? [];
    if (opts.mode === "incremental" && explicit.length === 0) {
      // Baseline (Story 6.7): "last-run" (default) diffs against the last-successful-run content
      // snapshot; a missing/invalid snapshot returns null so we fall back to the git-HEAD baseline
      // (never under-select). "head" opts out and always uses the git-HEAD diff. Either way we
      // capture the current candidate hashes NOW (selection time) as `pendingSnapshot`; it becomes
      // the new baseline only if the run succeeds — re-hashing post-run would hide a mid-run edit.
      const since = opts.since ?? "last-run";
      let changed: { files: string[]; added: string[] } | null;
      let pendingSnapshot: SnapshotFile | null;
      if (since === "head") {
        changed = getChangedFiles(project.path);
        pendingSnapshot = snapshotPayload(project.path);
      } else {
        const delta = selectionDelta(project.path);
        changed = delta.changed ?? getChangedFiles(project.path);
        pendingSnapshot = delta.pending;
      }
      const map = loadCoverageMap(project.path);
      // Only worth checking when there's a map to combine it with — a NEW-source caveat is
      // otherwise unreachable (no map -> "changed-only" short-circuits before that branch).
      const dynamicImportsPresent = map ? hasDynamicImportSyntax(project.path) : false;
      const plan = SelectionEngine.plan({
        changedFiles: changed?.files ?? null,
        addedFiles: changed?.added,
        map,
        strict: opts.strict,
        dynamicImportsPresent,
      });
      if (plan.strategy === "full") {
        return { files: [], changed: false, strategy: "full", reason: plan.reason, empty: false, deltaDriven: true, pendingSnapshot, confidence: plan.confidence };
      }
      if (plan.strategy === "changed-only") {
        // worker runs `--changed` with a full-suite fallback (Story 3.1)
        return { files: [], changed: true, strategy: "incremental", reason: plan.reason, empty: false, deltaDriven: true, pendingSnapshot, confidence: plan.confidence };
      }
      // Nothing to run and no static-graph union requested -> short-circuit (empty filter would be a full run).
      if (plan.testFiles.length === 0 && !plan.union) {
        return { files: [], changed: false, strategy: "incremental", reason: plan.reason, empty: true, deltaDriven: true, pendingSnapshot, confidence: plan.confidence };
      }
      return {
        files: plan.testFiles,
        changed: plan.union,
        strategy: "incremental",
        reason: plan.reason,
        empty: false,
        deltaDriven: true,
        pendingSnapshot,
        confidence: plan.confidence,
      };
    }
    if (explicit.length > 0) {
      return {
        files: explicit,
        changed: false,
        strategy: "incremental",
        reason: "explicit file selection",
        empty: false,
        deltaDriven: false,
        // The caller pinned these files; completeness of that choice is theirs to own -> high.
        confidence: { level: "high", reasons: [] },
      };
    }
    return { files: [], changed: false, strategy: "full", reason: "full suite", empty: false, deltaDriven: false, confidence: { level: "high", reasons: [] } };
  }

  private async execute(
    project: ProjectRef,
    sel: ResolvedSelection,
    coverage: boolean,
    runId: string,
    onProgress?: ProgressFn,
  ): Promise<TestResult> {
    // Bound total concurrent workers across all projects; release the slot once settled.
    await this.acquireWorker();
    try {
      return await this.executeWorker(project, sel, coverage, runId, onProgress);
    } finally {
      this.releaseWorker();
    }
  }

  private executeWorker(
    project: ProjectRef,
    sel: ResolvedSelection,
    coverage: boolean,
    runId: string,
    onProgress?: ProgressFn,
  ): Promise<TestResult> {
    const { files, changed } = sel;
    return new Promise<TestResult>((resolve, reject) => {
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      this.setRunState(project.projectId, {
        state: "running",
        progress: undefined,
        lastError: undefined,
        runId,
      });

      // Bounded, transient live view (Story 8.5) -- created up front so a hang before the worker
      // even reaches "ready" is still observable, and retained through settle (see finish()) so
      // an operator inspecting it right after an error/stall-kill still sees what led to it.
      const live: LiveRunState = {
        runId,
        lastProgressAt: Date.now(),
        tests: new Map(),
        testOrder: [],
        testsTruncated: false,
        log: [],
        stdoutResidual: "",
        stderrResidual: "",
      };
      this.liveRuns.set(project.projectId, live);

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
        }, project.path);
        this.setRunState(project.projectId, { state: "error", lastError: err.message, progress: undefined, runId });
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
        // stdout/stderr piped (Story 8.5) so both can be captured into the live log ring; stderr
        // is also still written straight through to the daemon's own stderr, unchanged from today.
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });

      const pushLogLine = (stream: "stdout" | "stderr", text: string): void => {
        const clipped = text.length > MAX_LOG_LINE_CHARS ? text.slice(0, MAX_LOG_LINE_CHARS) + "…[truncated]" : text;
        live.log.push({ stream, text: clipped, at: new Date().toISOString() });
        if (live.log.length > MAX_LOG_LINES) live.log.shift();
      };
      // Separate stateful decoders per stream: a multi-byte UTF-8 character split across two
      // `data` chunks must be reassembled correctly rather than decoded chunk-by-chunk (which
      // would render replacement characters for the split bytes on each side).
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      const appendLog = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        const key = stream === "stdout" ? "stdoutResidual" : "stderrResidual";
        live[key] += decoders[stream].write(chunk);
        if (live[key].length > MAX_RESIDUAL_CHARS) {
          // No newline for MAX_RESIDUAL_CHARS: force-flush so one pathological chunk can't grow forever.
          pushLogLine(stream, live[key].slice(0, MAX_LOG_LINE_CHARS) + "…[line truncated]");
          live[key] = "";
        }
        const lines = live[key].split("\n");
        live[key] = lines.pop() ?? ""; // last (possibly partial) segment stays as residual
        for (const l of lines) pushLogLine(stream, l);
        if (lines.length) this.notifyStatusChange();
      };
      child.stdout?.on("data", (chunk: Buffer) => appendLog("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk); // preserve today's passthrough exactly
        appendLog("stderr", chunk);
      });

      let settled = false;
      // Never pass a huge/Infinity delay to setTimeout directly (Node's delay is a 32-bit signed
      // int -- max 2147483647ms, ~24.8 days -- and an overflowing value fires almost immediately)
      // -- only schedule a timer at all when a finite positive cap within that range is
      // configured. Unset (the default) means the run is uncapped.
      const MAX_SETTIMEOUT_MS = 2_147_483_647;
      const timer =
        this.runTimeoutMs != null &&
        Number.isFinite(this.runTimeoutMs) &&
        this.runTimeoutMs > 0 &&
        this.runTimeoutMs <= MAX_SETTIMEOUT_MS
          ? setTimeout(() => {
              finish(() => failRun(new WorkerError(`worker timed out after ${this.runTimeoutMs}ms`)));
            }, this.runTimeoutMs)
          : undefined;

      // Stall watchdog (Story 8.5/AD-20) -- provisional (staleTestGraceMs ALONE, not
      // testTimeout+grace) until the worker has sent ANY message, since a hang in the worker's own
      // config-discovery step -- before it can send anything at all -- must be caught just as
      // promptly as a later stall. Once heard from, rearmed at testTimeout + staleTestGraceMs on
      // every test-level progress signal (full setTimeout reschedule, not a poll). Reuses
      // `finish()` -- no second kill path alongside the runTimeoutMs cap above.
      let effectiveTestTimeoutMs = DEFAULT_UNKNOWN_TEST_TIMEOUT_MS;
      let hasHeardFromWorker = false;
      let stallTimer: NodeJS.Timeout | undefined;
      const scheduleStallCheck = (): void => {
        if (stallTimer) clearTimeout(stallTimer);
        const thresholdMs = hasHeardFromWorker
          ? effectiveTestTimeoutMs + this.staleTestGraceMs
          : this.staleTestGraceMs;
        stallTimer = setTimeout(() => {
          const elapsed = Date.now() - live.lastProgressAt;
          const basis = hasHeardFromWorker
            ? `testTimeout ${effectiveTestTimeoutMs}ms + grace ${this.staleTestGraceMs}ms`
            : `provisional grace ${this.staleTestGraceMs}ms, no worker message yet`;
          finish(() =>
            failRun(
              new WorkerError(
                `worker stalled: no test progress for ${elapsed}ms (threshold ${thresholdMs}ms = ${basis})`,
              ),
            ),
          );
        }, thresholdMs);
      };
      const armWatchdog = (testTimeoutMs?: number): void => {
        hasHeardFromWorker = true;
        if (testTimeoutMs !== undefined) {
          effectiveTestTimeoutMs = Math.min(
            Math.max(testTimeoutMs, MIN_SANE_TEST_TIMEOUT_MS),
            MAX_SANE_TEST_TIMEOUT_MS,
          );
          live.testTimeoutMs = effectiveTestTimeoutMs;
        }
        scheduleStallCheck();
      };
      const touchLiveProgress = (): void => {
        hasHeardFromWorker = true;
        live.lastProgressAt = Date.now();
        scheduleStallCheck();
        this.notifyStatusChange();
      };
      scheduleStallCheck(); // provisional arm (staleTestGraceMs alone), before any worker message

      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (stallTimer) clearTimeout(stallTimer);
        // Flush any trailing partial (no-newline) line rather than silently dropping it.
        if (live.stdoutResidual) pushLogLine("stdout", live.stdoutResidual);
        if (live.stderrResidual) pushLogLine("stderr", live.stderrResidual);
        child.removeAllListeners();
        // child.stdout/stderr are separate EventEmitters -- removeAllListeners() above doesn't
        // touch them, so without this, OS-buffered stdio arriving after kill() could still append
        // to `live.log` for a run that has already settled.
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        if (!child.killed) child.kill();
        act();
      };

      const upsertLiveTest = (
        file: string,
        name: string,
        status: LiveTestEntry["status"],
      ): void => {
        const key = liveTestKey(file, name);
        const isNew = !live.tests.has(key);
        if (isNew && live.tests.size >= MAX_LIVE_TEST_ENTRIES) {
          // Ring, not a frozen cap: evict the oldest so the visible list is always the most recent.
          const oldest = live.testOrder.shift();
          if (oldest !== undefined) live.tests.delete(oldest);
          live.testsTruncated = true;
        }
        live.tests.set(key, { file, name, status });
        if (isNew) live.testOrder.push(key);
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
          touchLiveProgress();
        } else if (msg.type === "config" && msg.runId === runId) {
          armWatchdog(msg.testTimeoutMs);
          touchLiveProgress();
        } else if (msg.type === "case-start" && msg.runId === runId) {
          upsertLiveTest(msg.file, msg.name, "running");
          touchLiveProgress();
        } else if (msg.type === "case-result" && msg.runId === runId) {
          upsertLiveTest(msg.file, msg.name, msg.status);
          touchLiveProgress();
        } else if (msg.type === "phase-progress" && msg.runId === runId) {
          // Coverage-measurement heartbeat (AD-20) -- surfaced identically to test-level progress
          // (AD-21), not merely an internal watchdog-reset signal.
          live.phase = { phase: msg.phase, completed: msg.completed, total: msg.total };
          touchLiveProgress();
        } else if (msg.type === "result" && msg.runId === runId) {
          if (!msg.result) {
            finish(() => failRun(new WorkerError("worker returned no result")));
          } else {
            const failureDetails = msg.failureDetails ?? [];
            const map = new Map<string, FailureDetail>();
            for (const d of failureDetails) map.set(d.id, d);
            this.lastFailures.set(project.projectId, map);
            const result = msg.result;
            // Surface the orchestrator's specific decision reason over the worker's generic
            // labels ("full suite"/"explicit file selection"). Exception: the git `--changed`
            // execution-time fallback — the decision was incremental but the worker ran the
            // full suite because no test was affected; there the worker's outcome is the
            // truthful description, so preserve it. `selection.files` is always what ran.
            const executionFallback =
              result.selection.strategy === "full" && sel.strategy === "incremental";
            if (!executionFallback) {
              result.selection.reason = sel.reason;
              result.selection.strategy = sel.strategy;
            }
            // Attach the selection confidence (Story 6.8). A full run — planned OR reached via the
            // worker's `--changed`→full execution fallback — actually ran everything, so it is
            // complete: force `high` in that case regardless of the plan's (now moot) verdict.
            result.confidence = executionFallback ? { level: "high", reasons: [] } : sel.confidence;
            // Advance the last-run snapshot only after a successful delta-driven run (Story 6.7):
            // a failing run leaves it untouched so its changed files stay in the next delta.
            this.advanceSnapshotIfDeltaRun(project, sel, result);
            this.recordRun({
              runId,
              projectId: project.projectId,
              startedAt,
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              status: "complete",
              result,
              failures: failureDetails,
            }, project.path);
            this.setRunState(project.projectId, {
              state: "complete",
              lastResult: result,
              progress: undefined,
              runId,
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
      child.on("exit", (code, signal) =>
        finish(() =>
          failRun(
            new WorkerError(
              `worker exited (code ${code}, signal ${signal}) before returning a result` +
                (signal === "SIGKILL"
                  ? " -- SIGKILL is almost always the OS OOM killer; check available memory"
                  : ""),
            ),
          ),
        ),
      );
    });
  }

  /**
   * Persist the last-run snapshot after a successful delta-driven incremental run (Story 6.7).
   * We save the payload captured at SELECTION time (`sel.pendingSnapshot`), not a fresh re-hash:
   * a changed file whose run failed is never hidden (the snapshot isn't advanced at all), and an
   * edit landing mid-run isn't silently baselined as validated (its selection-time hash is what
   * we persist, so a later edit still differs and stays in the next delta). A write failure must
   * never fail the run (invariant: never crash the daemon) — it is logged to stderr only.
   *
   * A `degraded` run (Story 6.8) is NOT allowed to advance the snapshot: the selection was bounded
   * but not provably complete, so baselining its files as "validated" would drop them from future
   * deltas and hide a regression the bounded run never exercised. They stay in the next delta until
   * a `high` run (all sources mapped, or a full run) validates them — the safe, self-healing choice.
   */
  private advanceSnapshotIfDeltaRun(
    project: ProjectRef,
    sel: ResolvedSelection,
    result: TestResult,
  ): void {
    if (!sel.deltaDriven || !result.success || !sel.pendingSnapshot) return;
    if (result.confidence?.level === "degraded") return;
    try {
      saveSnapshot(project.path, sel.pendingSnapshot);
    } catch (err) {
      process.stderr.write(
        `[test-mcp] failed to write last-run snapshot for ${project.projectId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  /** Look up a failure from the project's most recent run. */
  getFailureDetail(projectId: string, failureId: string): FailureDetail | undefined {
    return this.lastFailures.get(projectId)?.get(failureId);
  }

  /** Current pollable run state for a project (Story 4.2). */
  getRunStatus(projectId: string): RunStatus {
    return this.runState.get(projectId) ?? { state: "idle" };
  }

  /**
   * Bounded live view of a project's current/most-recent run (Story 8.5) — undefined only if no
   * run has ever started for this project (never mid-settle-cleanup; live state is retained
   * until the next run for that project starts, so a poll right after an error/stall-kill still
   * shows what led to it).
   */
  getLiveRun(projectId: string):
    | {
        runId: string;
        testTimeoutMs?: number;
        tests: LiveTestEntry[];
        testsTruncated: boolean;
        log: LiveLogLine[];
        phase?: LivePhase;
        lastProgressAt: number;
      }
    | undefined {
    const live = this.liveRuns.get(projectId);
    if (!live) return undefined;
    return {
      runId: live.runId,
      testTimeoutMs: live.testTimeoutMs,
      tests: live.testOrder.map((k) => live.tests.get(k)!),
      testsTruncated: live.testsTruncated,
      log: live.log,
      phase: live.phase,
      lastProgressAt: live.lastProgressAt,
    };
  }

  /** Retained run history for a project, newest first (in-memory, capped). */
  getRunHistory(projectId: string): RunRecord[] {
    return this.history.get(projectId) ?? [];
  }

  /**
   * Rehydrate a project's in-memory history from disk (Story 6.2) — called for each registered
   * project at daemon startup so past runs survive a restart. A read failure leaves the buffer
   * empty rather than crashing (never crash the daemon).
   */
  loadHistory(projectId: string, projectPath: string): void {
    try {
      this.history.set(projectId, loadHistoryFromDisk(projectPath, this.maxHistory));
    } catch (err) {
      process.stderr.write(
        `[test-mcp] failed to load run history for ${projectId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  /** A single retained run by id, or undefined if evicted/unknown. */
  getRun(projectId: string, runId: string): RunRecord | undefined {
    return this.history.get(projectId)?.find((r) => r.runId === runId);
  }

  /**
   * Rehydrate a project's in-memory test inventory from disk — called for each registered
   * project at daemon startup (mirrors `loadHistory`) so "total tests" survives a restart without
   * waiting for every file to re-run. A read failure leaves the inventory empty rather than
   * crashing (never crash the daemon); it self-heals as runs occur.
   */
  loadTestInventory(projectId: string, projectPath: string): void {
    try {
      const raw = loadTestInventoryFromDisk(projectPath);
      const map = new Map<string, Set<string>>();
      for (const [file, names] of Object.entries(raw)) {
        map.set(file, new Set(names));
      }
      this.testInventory.set(projectId, map);
    } catch (err) {
      process.stderr.write(
        `[test-mcp] failed to load test inventory for ${projectId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  /** Sum of cached test-name-set sizes across every file in the project's inventory. */
  getTestInventoryCount(projectId: string): number {
    const inv = this.testInventory.get(projectId);
    if (!inv) return 0;
    let count = 0;
    for (const names of inv.values()) count += names.size;
    return count;
  }

  /**
   * Reconcile the project's test inventory from one run's result: for every file the run actually
   * executed (`result.selection.files`), replace that file's cached test-name set with the names
   * seen in THIS run's `tests` for that file. Files not in the selection are left untouched — this
   * is what makes it deletion-aware (a file dropping a test only self-heals the next time IT runs)
   * without depending on retained history depth. Applies uniformly to full and incremental runs
   * (no `strategy` branch needed — `selection.files` already reflects what ran either way).
   *
   * Skipped entirely when `testsTruncated` is true: an incomplete `tests` list must never be used
   * to delete a cached name (over-count is the safe direction, matching the Selection Engine's
   * degraded-confidence bias). Also a safe no-op for `emptyResult()` runs, whose `selection.files`
   * is always `[]`.
   */
  private reconcileTestInventory(projectId: string, projectPath: string, result: TestResult): void {
    if (result.testsTruncated) return;
    const files = result.selection.files;
    if (files.length === 0) return;
    // A file whose module failed to load collapses its real test names down to a single
    // synthetic "(module load error)" entry (mapModulesToResult's `::collect` failures) — that is
    // NOT a complete test list for the file. Treat it like a truncated result and leave the
    // file's cached entry untouched, so a transient syntax/collect error never silently
    // under-counts a file's real tests (over-count is the safe direction, never delete on
    // incomplete data).
    const loadErrorFiles = new Set(
      result.failures.filter((f) => f.id.endsWith("::collect")).map((f) => f.file),
    );
    const byFile = new Map<string, Set<string>>();
    for (const t of result.tests ?? []) {
      const names = byFile.get(t.file) ?? new Set<string>();
      names.add(t.name);
      byFile.set(t.file, names);
    }
    const inventory = this.testInventory.get(projectId) ?? new Map<string, Set<string>>();
    for (const file of files) {
      if (loadErrorFiles.has(file)) continue;
      inventory.set(file, byFile.get(file) ?? new Set<string>());
    }
    this.testInventory.set(projectId, inventory);

    // Best-effort persistence (mirrors recordRun's history write): a failure here must never fail
    // the run or crash the daemon.
    try {
      const onDisk: TestInventory = {};
      for (const [file, names] of inventory) onDisk[file] = [...names];
      saveTestInventory(projectPath, onDisk);
    } catch (err) {
      process.stderr.write(
        `[test-mcp] failed to persist test inventory for ${projectId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  /**
   * Append a completed run to the project's history ring buffer (newest first, capped) and mirror
   * it to disk (Story 6.2). Disk persistence is best-effort — a write/prune failure is logged and
   * swallowed so it never fails the run or crashes the daemon (the in-memory buffer still has it).
   */
  private recordRun(record: RunRecord, projectPath: string): void {
    // Defensive deep copy (Story 6.4 deferral): the same TestResult is fanned out to history,
    // run-state, and the caller. Cloning here decouples the retained/persisted copy so a later
    // in-place mutation of the returned result (or of lastResult) can never corrupt history.
    const stored: RunRecord = record.result
      ? { ...record, result: structuredClone(record.result) }
      : record;
    const list = this.history.get(stored.projectId) ?? [];
    list.unshift(stored);
    if (list.length > this.maxHistory) list.length = this.maxHistory;
    this.history.set(stored.projectId, list);
    if (record.result) {
      this.reconcileTestInventory(record.projectId, projectPath, record.result);
    }
    try {
      writeRunRecord(projectPath, stored);
      pruneHistory(projectPath, this.maxHistory);
    } catch (err) {
      process.stderr.write(
        `[test-mcp] failed to persist run ${record.runId} for ${record.projectId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  /** Subscribe to run-state changes (Story 5.1 UI push). Returns an unsubscribe fn. */
  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setRunState(projectId: string, patch: Partial<RunStatus>): void {
    const prev = this.runState.get(projectId) ?? { state: "idle" as const };
    // Clone lastResult so run-state holds a copy independent of history and the returned result
    // (Story 6.4 deferral — see recordRun).
    const clean = patch.lastResult
      ? { ...patch, lastResult: structuredClone(patch.lastResult) }
      : patch;
    this.runState.set(projectId, { ...prev, ...clean, updatedAt: new Date().toISOString() });
    this.notifyStatusChange();
  }

  /** Fan out to every status-change subscriber (Story 5.1 UI push; Story 8.5 live-state pushes too). */
  private notifyStatusChange(): void {
    for (const fn of this.statusListeners) {
      try {
        fn();
      } catch {
        // a broken subscriber must never break a run
      }
    }
  }
}

/** A trivially-successful result for "nothing to run" (e.g. incremental with no changes).
 *  An empty run is always an incremental no-op — never a full suite. */
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
