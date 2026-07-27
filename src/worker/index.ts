import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import libCoverage from "istanbul-lib-coverage";
import type { TestResult, FailureDetail, CoveragePct } from "../types/contracts.js";
import { parseToWorker, type ToWorker, type FromWorker } from "../types/ipc.js";
import { isTestFile } from "../selection/index.js";

/**
 * Extract the project's GLOBAL numeric-% coverage thresholds from a Vitest `coverage.thresholds`
 * config (Story 6.3 AC4). Handles the plain metric form (`{ lines: 90, ... }`) and the `100: true`
 * shorthand ("require 100% everywhere"). Per-glob thresholds, `perFile`, `autoUpdate`, and negative
 * (absolute-count) thresholds are intentionally NOT surfaced — we report only what we can compare to
 * the reported percentages, rather than invent a verdict. Returns null when there's no global % form.
 * Relocated from the now-deleted `src/coverage/combined.ts` (Story 3.8 Task 5.2) -- this worker is
 * the only remaining consumer.
 */
export function parseGlobalThresholds(raw: unknown): Partial<CoveragePct> | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t["100"] === true) return { statements: 100, branches: 100, functions: 100, lines: 100 };
  const out: Partial<CoveragePct> = {};
  for (const m of ["statements", "branches", "functions", "lines"] as const) {
    const v = t[m];
    // Positive 0–100 is a percentage target; a negative value is a max-uncovered-count (skipped).
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) out[m] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** True when `total` meets every configured threshold. Relocated alongside `parseGlobalThresholds`. */
export function meetsThresholds(total: CoveragePct, thresholds: Partial<CoveragePct>): boolean {
  return (["statements", "branches", "functions", "lines"] as const).every(
    (m) => thresholds[m] === undefined || total[m] >= (thresholds[m] as number),
  );
}

// TEMPORARY diagnostic instrumentation (not a permanent feature) for investigating a real-project
// OOM crash during coverage-enabled runs: heap climbs to the default ~4GB ceiling over a long run
// and the worker crashes rather than completing. ON BY DEFAULT for now (to capture data on the
// affected machine without needing extra env-var setup there) -- set TEST_MCP_DEBUG_MEMORY=0 to
// silence it. Written to a file (not stderr) because the daemon normally spawns with
// stdio:"ignore", so stderr never reaches anywhere the operator can read it; a file inside the
// project's own .test-mcp/ (already the convention for per-project state, see CLAUDE.md) is
// reachable regardless of how the daemon/worker were started. Remove once the leak is found and
// fixed -- flip this back to opt-in (or delete entirely) once real data is in hand.
function logMemory(cwd: string, label: string, extra: Record<string, unknown> = {}): void {
  if (process.env.TEST_MCP_DEBUG_MEMORY === "0") return;
  try {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    const line = JSON.stringify({
      t: new Date().toISOString(),
      label,
      rssMB: mb(m.rss),
      heapUsedMB: mb(m.heapUsed),
      heapTotalMB: mb(m.heapTotal),
      externalMB: mb(m.external),
      arrayBuffersMB: mb(m.arrayBuffers),
      ...extra,
    });
    fs.mkdirSync(path.join(cwd, ".test-mcp"), { recursive: true });
    fs.appendFileSync(path.join(cwd, ".test-mcp", "debug-memory.log"), line + "\n");
  } catch {
    // diagnostic logging must never crash the very run it's trying to help debug
  }
}

// Minimal structural typing for the parts of the Vitest reporter API we consume.
// (Vitest is resolved dynamically from the project, so we cannot import its types here.)
interface VError {
  message?: string;
  stack?: string;
  name?: string;
  expected?: string;
  actual?: string;
  diff?: string;
}
interface VTestResult {
  state: "passed" | "failed" | "skipped" | "pending";
  errors?: ReadonlyArray<VError>;
}
interface VTestCase {
  id: string;
  fullName: string;
  module: { moduleId: string };
  result(): VTestResult;
}
interface VTestModule {
  moduleId: string;
  diagnostic(): { duration: number };
  errors(): ReadonlyArray<VError>;
  children: { allTests(): Iterable<VTestCase> };
}
interface VitestInstance {
  close(): Promise<void>;
  config: { isolate: boolean };
}

/** createVitest returns an instance we use to discover test files and read resolved config. */
interface DiscoveryInstance {
  close(): Promise<void>;
  globTestSpecifications(): Promise<ReadonlyArray<{ moduleId: string }>>;
  /**
   * Resolved config — we read the project's coverage thresholds for the gate (Story 6.3 AC4)
   * and its testTimeout for the stall watchdog (Story 8.2), without running any tests.
   */
  config?: { coverage?: { thresholds?: unknown }; testTimeout?: number };
}

interface VitestNode {
  startVitest(
    mode: string,
    cliFilters: string[],
    options: Record<string, unknown>,
  ): Promise<VitestInstance | false>;
  createVitest(mode: string, options: Record<string, unknown>): Promise<DiscoveryInstance>;
}

interface RunOnceResult {
  modules: ReadonlyArray<VTestModule>;
  unhandled: ReadonlyArray<VError>;
  wallClockMs: number;
  isolate: boolean;
}

/** Vitest's "pending" case state folds into "failed", matching mapModulesToResult's existing rule. */
function mapCaseStatus(state: VTestResult["state"]): "passed" | "failed" | "skipped" {
  return state === "pending" ? "failed" : state;
}

// Vitest 4's default `forks` pool has a documented, transient upstream bug: its own internal
// ~90s WORKER_START_TIMEOUT can fire spawning a per-file worker under resource pressure, throwing
// `[vitest-pool]: Failed to start <worker> worker for test files <...>` even though a re-run
// typically succeeds. 1 initial attempt + 2 retries, delay scaled per attempt (a failure
// attributed to "resource pressure" deserves a little more room to clear before trying again,
// not the same fixed wait every time).
const POOL_START_MAX_ATTEMPTS = 3;
const POOL_START_RETRY_DELAY_MS = 1000;
// While an attempt is pending, heartbeat the orchestrator so its stall watchdog (armed at
// testTimeoutMs + staleTestGraceMs, ~10s by default) doesn't kill the worker mid-wait -- Vitest's
// own internal timeout for this specific failure is ~90s, far longer than that default. Capped
// PER ATTEMPT (not cumulatively across retries -- each attempt is an independent, fresh chance at
// the same ~90s-scale wait) so a GENUINELY wedged startVitest() call (a different, real bug)
// still eventually falls back to the orchestrator's normal stall detection.
const POOL_START_HEARTBEAT_INTERVAL_MS = 4000;
const POOL_START_HEARTBEAT_MAX_MS = 130_000;

// Coverage generation has its OWN heartbeat window, separate from pool-start (see
// `withCoverageTailHeartbeat`): after the last test module ends, Vitest still collects V8
// coverage, remaps it to istanbul, and writes coverage-final.json before startVitest resolves --
// a silent tail with no test-progress signal that can exceed the watchdog's ~10s default on a
// large project (this story's exact "large project + coverage" symptom). The cap is far larger
// than the pool-start one -- 30 minutes, matching the retired NATIVE_COVERAGE_HEARTBEAT_FLOOR_MS
// intent -- because coverage of a big suite legitimately takes far longer than a worker-start
// wait, yet it's STILL capped so a genuinely wedged coverage generation eventually falls through
// to the orchestrator's stall detection rather than heartbeating forever.
const COVERAGE_TAIL_HEARTBEAT_INTERVAL_MS = 4000;
const COVERAGE_TAIL_HEARTBEAT_MAX_MS = 1_800_000;

/** Classify by message only, never by error type -- Vitest throws a plain Error here, and this
 *  must never widen to "retry any startVitest failure" (a real test/config error must fail fast).
 *  `[\s\S]` (not `.`) so an embedded newline in the message still matches. */
function isTransientPoolStartFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\[vitest-pool\]:\s*Failed to start[\s\S]+worker for test files/.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `attempt` with a `config` heartbeat firing on an interval while it's pending, so the
 * orchestrator's stall watchdog sees signs of life during Vitest's own slow-but-legitimate
 * worker-start wait. Sends `testTimeoutMs` when known; omits it when not -- either way
 * `armWatchdog` on the receiving end resets the watchdog's timer (an absent value just skips
 * updating the *effective* timeout, per its existing, unchanged behavior), so this closes the
 * gap for projects whose config discovery didn't resolve a real value instead of accepting it.
 */
async function withPoolStartHeartbeat<T>(
  runId: string,
  testTimeoutMs: number | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  const sendHeartbeat = (): void => {
    try {
      send({ type: "config", runId, ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}) });
    } catch {
      // never let a heartbeat failure (e.g. a torn-down IPC channel) crash the worker
    }
  };
  // Fire one immediately -- if testTimeoutMs is unknown, the orchestrator's watchdog is still in
  // its short provisional phase (staleTestGraceMs alone, default 5000ms); waiting for the first
  // POOL_START_HEARTBEAT_INTERVAL_MS tick could burn most of that margin before any signal arrives.
  sendHeartbeat();
  const heartbeatStart = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - heartbeatStart > POOL_START_HEARTBEAT_MAX_MS) {
      clearInterval(timer);
      return;
    }
    sendHeartbeat();
  }, POOL_START_HEARTBEAT_INTERVAL_MS);
  try {
    return await attempt();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Run `attempt` (a coverage-enabled `runOnce`) with a `config` heartbeat firing on an interval
 * while it's pending, so the orchestrator's stall watchdog isn't tripped during the SILENT tail
 * after the last test module ends -- V8 coverage collection, istanbul remapping, and the
 * coverage-final.json write all happen with no test-progress signal (see the constants above).
 * Mirrors `withPoolStartHeartbeat`, but with no immediate fire: real test progress already arms
 * the watchdog throughout the test phase, so only the post-test tail needs covering, and the
 * interval (well under the watchdog's threshold) picks it up within one tick of the final module.
 * The `send` is guarded so a torn-down IPC channel can never crash the worker.
 */
export async function withCoverageTailHeartbeat<T>(
  runId: string,
  testTimeoutMs: number | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  const sendHeartbeat = (): void => {
    try {
      send({ type: "config", runId, ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}) });
    } catch {
      // never let a heartbeat failure (e.g. a torn-down IPC channel) crash the worker
    }
  };
  const heartbeatStart = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - heartbeatStart > COVERAGE_TAIL_HEARTBEAT_MAX_MS) {
      clearInterval(timer);
      return;
    }
    sendHeartbeat();
  }, COVERAGE_TAIL_HEARTBEAT_INTERVAL_MS);
  try {
    return await attempt();
  } finally {
    clearInterval(timer);
  }
}

/** Execute Vitest once with the given filters/options and capture reporter output. */
async function runOnce(
  startVitest: VitestNode["startVitest"],
  filters: string[],
  extraOptions: Record<string, unknown>,
  runId: string,
  onProgress?: (completed: number, total: number) => void,
  testTimeoutMs?: number,
): Promise<RunOnceResult> {
  // Fresh per attempt (buildReporter(), not a single shared closure) -- a discarded attempt's
  // partial progress (onTestRunStart/onTestModuleEnd having already fired before a LATER pool
  // worker failed to start for a subsequent file) must never leak into a retried attempt's numbers.
  const buildReporter = () => {
    let modules: ReadonlyArray<VTestModule> = [];
    let unhandled: ReadonlyArray<VError> = [];
    let total = 0;
    let completed = 0;
    const reporter = {
      onTestRunStart(specifications: ReadonlyArray<unknown>) {
        total = specifications.length;
        onProgress?.(0, total);
      },
      onTestModuleEnd() {
        completed += 1;
        onProgress?.(completed, total);
      },
      onTestRunEnd(testModules: ReadonlyArray<VTestModule>, unhandledErrors: ReadonlyArray<VError>) {
        modules = testModules;
        unhandled = unhandledErrors;
      },
      // Optional, Vitest 3+ only (Story 8.2) — an older project Vitest simply never calls these.
      // Wrapped defensively: a reporter hook must never crash the worker or abort the run.
      onTestCaseReady(testCase: VTestCase) {
        try {
          send({ type: "case-start", runId, file: testCase.module.moduleId, name: testCase.fullName });
        } catch {
          // never let a reporter hook failure break the run
        }
      },
      onTestCaseResult(testCase: VTestCase) {
        try {
          send({
            type: "case-result",
            runId,
            file: testCase.module.moduleId,
            name: testCase.fullName,
            status: mapCaseStatus(testCase.result().state),
          });
        } catch {
          // ditto
        }
      },
    };
    return { reporter, getModules: () => modules, getUnhandled: () => unhandled };
  };

  let vitest: VitestInstance | false | undefined;
  let wallClockMs = 0;
  let modules: ReadonlyArray<VTestModule> = [];
  let unhandled: ReadonlyArray<VError> = [];
  for (let attempt = 1; attempt <= POOL_START_MAX_ATTEMPTS; attempt++) {
    const { reporter, getModules, getUnhandled } = buildReporter();
    const attemptStart = Date.now();
    try {
      vitest = await withPoolStartHeartbeat(runId, testTimeoutMs, () =>
        startVitest("test", filters, {
          watch: false,
          reporters: [reporter],
          coverage: { enabled: false },
          // Vitest intercepts console.log/error from within test files by default (to attribute
          // them to a test in ITS OWN reporter output) instead of writing straight to this
          // process's real stdout/stderr -- discovered via smoke testing (Story 8.5's log tail
          // stayed empty against a real project despite console output). Disabling interception
          // is what makes that output reach the orchestrator's log-capture pipe/tee at all; we
          // don't consume onUserConsoleLog (Vitest's own attributed-log hook), so there's nothing
          // else this option would break.
          disableConsoleIntercept: true,
          ...extraOptions,
        }),
      );
      wallClockMs = Date.now() - attemptStart; // per-attempt, so retry/backoff time never inflates it
      modules = getModules();
      unhandled = getUnhandled();
      break;
    } catch (err) {
      if (!isTransientPoolStartFailure(err) || attempt === POOL_START_MAX_ATTEMPTS) throw err;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[test-mcp] retrying vitest-pool worker start (attempt ${attempt}/${POOL_START_MAX_ATTEMPTS}): ${message}\n`,
      );
      await sleep(POOL_START_RETRY_DELAY_MS * attempt);
    }
  }
  if (!vitest) throw new Error("Vitest failed to start");
  const isolate = vitest.config.isolate ?? true;
  try {
    return { modules, unhandled, wallClockMs, isolate };
  } finally {
    await vitest.close();
  }
}

/** Cap the per-test detail list (Story 6.1) so a huge suite can't grow the result unboundedly. */
const MAX_TEST_ENTRIES = 1000;

/** Convert captured Vitest reporter data into our TestResult contract. Pure — unit-testable. */
export function mapModulesToResult(
  modules: ReadonlyArray<VTestModule>,
  unhandled: ReadonlyArray<VError>,
  wallClockMs: number,
  selection: { strategy: "full" | "incremental"; reason: string },
  isolate: boolean,
): TestResult {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let testExecMs = 0;
  const failures: TestResult["failures"] = [];
  const filesRun: string[] = [];
  // Per-test detail for the run-detail UI (Story 6.1) — collected in this SAME pass (no second run).
  const tests: NonNullable<TestResult["tests"]> = [];

  for (const m of modules) {
    filesRun.push(m.moduleId);
    testExecMs += m.diagnostic().duration ?? 0;

    for (const err of m.errors()) {
      failed++;
      failures.push({
        id: `${m.moduleId}::collect`,
        name: "(module load error)",
        file: m.moduleId,
        message: err.message ?? "Module failed to load",
      });
      tests.push({ name: "(module load error)", file: m.moduleId, status: "failed" });
    }

    for (const tc of m.children.allTests()) {
      const r = tc.result();
      if (r.state === "passed") {
        passed++;
        tests.push({ name: tc.fullName, file: tc.module.moduleId, status: "passed" });
      } else if (r.state === "skipped") {
        skipped++;
        tests.push({ name: tc.fullName, file: tc.module.moduleId, status: "skipped" });
      } else if (r.state === "failed") {
        failed++;
        failures.push({
          id: tc.id,
          name: tc.fullName,
          file: tc.module.moduleId,
          message: r.errors?.[0]?.message ?? "Test failed",
        });
        tests.push({ name: tc.fullName, file: tc.module.moduleId, status: "failed" });
      } else if (r.state === "pending") {
        failed++;
        failures.push({
          id: tc.id,
          name: tc.fullName,
          file: tc.module.moduleId,
          message: "Test still pending",
        });
        // A pending test counts as a failure (consistent with the counts above).
        tests.push({ name: tc.fullName, file: tc.module.moduleId, status: "failed" });
      }
    }
  }


  unhandled.forEach((err, i) => {
    failed++;
    failures.push({
      id: `unhandled-${i}`,
      name: "(unhandled error)",
      file: "",
      message: err.message ?? "Unhandled error during run",
    });
    tests.push({ name: "(unhandled error)", file: "", status: "failed" });
  });

  // Cap the detail list AFTER every source of entries (cases, module-load + unhandled errors) so
  // the truncation flag reflects the true total (Story 6.1).
  const testsTruncated = tests.length > MAX_TEST_ENTRIES;
  const boundedTests = testsTruncated ? tests.slice(0, MAX_TEST_ENTRIES) : tests;

  const total = passed + failed + skipped;
  return {
    // A run that dispatched but matched no test cases is not a failure — nothing failed.
    // (Empty *selections* are short-circuited earlier by the orchestrator.)
    success: failed === 0,
    summary: buildSummary(passed, failed, skipped, total, wallClockMs, failures),
    duration: wallClockMs,
    total,
    passed,
    failed,
    skipped,
    failures,
    selection: {
      strategy: selection.strategy,
      reason: selection.reason,
      files: filesRun,
    },
    tests: boundedTests,
    ...(testsTruncated ? { testsTruncated: true } : {}),
    metadata: {
      wallClockMs,
      testExecMs,
      overheadMs: Math.max(0, wallClockMs - testExecMs),
      isolate,
    },
  };
}

/** A one-line, failure-forward summary (Story 4.3) — counts first, then the first few failing names. */
function buildSummary(
  passed: number,
  failed: number,
  skipped: number,
  total: number,
  wallClockMs: number,
  failures: TestResult["failures"],
): string {
  if (total === 0) return `no tests run (${wallClockMs}ms)`;
  // Denominator is EXECUTED tests only (passed+failed) — skipped tests must never be folded into
  // the ratio (they're stated separately here, right after it) or a run with skips reads as a
  // worse pass rate than what actually executed.
  const executed = passed + failed;
  // Every selected test was skipped: passed/0 would read as an ambiguous, vacuous "0/0 passed"
  // instead of communicating that nothing actually ran.
  if (executed === 0) return `all ${skipped} skipped, none executed (${wallClockMs}ms)`;
  const counts = `${passed}/${executed} passed, ${failed} failed, ${skipped} skipped (${wallClockMs}ms)`;
  if (failed === 0) return counts;
  const names = failures.slice(0, 3).map((f) => f.name);
  const more = failures.length > 3 ? ` +${failures.length - 3} more` : "";
  return `${counts} — FAILED: ${names.join("; ")}${more}`;
}

/** Build the on-demand failure detail list. Ids match mapModulesToResult's compact failures. */
export function mapFailureDetails(
  modules: ReadonlyArray<VTestModule>,
  unhandled: ReadonlyArray<VError>,
): FailureDetail[] {
  const details: FailureDetail[] = [];

  for (const m of modules) {
    for (const err of m.errors()) {
      details.push({
        id: `${m.moduleId}::collect`,
        name: "(module load error)",
        file: m.moduleId,
        message: err.message ?? "Module failed to load",
        stack: err.stack,
        expected: err.expected,
        actual: err.actual,
        diff: err.diff,
      });
    }
    for (const tc of m.children.allTests()) {
      const r = tc.result();
      if (r.state === "failed" || r.state === "pending") {
        const e = r.errors?.[0];
        details.push({
          id: tc.id,
          name: tc.fullName,
          file: tc.module.moduleId,
          message: e?.message ?? (r.state === "pending" ? "Test still pending" : "Test failed"),
          stack: e?.stack,
          expected: e?.expected,
          actual: e?.actual,
          diff: e?.diff,
        });
      }
    }
  }

  unhandled.forEach((err, i) => {
    details.push({
      id: `unhandled-${i}`,
      name: "(unhandled error)",
      file: "",
      message: err.message ?? "Unhandled error during run",
      stack: err.stack,
    });
  });

  return details;
}

/** Resolve the PROJECT's Vitest and run it, honouring git-delta selection with a safe fallback. */
export async function runVitest(
  cwd: string,
  opts: { files: string[]; relatedFiles?: string[] },
  runId: string,
  onProgress?: (completed: number, total: number) => void,
  /** The project's resolved Vitest testTimeout (Story 8.2's readResolvedRunConfig), threaded down
   *  so a pool-start retry (below) can heartbeat the orchestrator's stall watchdog while an
   *  attempt is pending. Undefined when discovery couldn't resolve it -- the heartbeat still
   *  fires, just without a testTimeoutMs value. */
  testTimeoutMs?: number,
  /** Test-only seam: inject a fake `startVitest` to exercise the pool-start retry logic
   *  deterministically, without needing to shadow the real `vitest` package's module exports.
   *  Never set in production -- the real project's Vitest is always resolved normally. */
  startVitestOverride?: VitestNode["startVitest"],
): Promise<{ result: TestResult; failureDetails: FailureDetail[] }> {
  const startVitest =
    startVitestOverride ??
    (createRequire(path.join(cwd, "__test-mcp-resolve__.js"))("vitest/node") as VitestNode)
      .startVitest;

  const build = (
    r: RunOnceResult,
    selection: { strategy: "full" | "incremental"; reason: string },
  ) => ({
    result: mapModulesToResult(r.modules, r.unhandled, r.wallClockMs, selection, r.isolate),
    failureDetails: mapFailureDetails(r.modules, r.unhandled),
  });

  // Related-based incremental selection (Story 3.8, AC1/AC4): feed Vitest's own `related` config
  // field the orchestrator's since-last-run delta so it resolves affected tests via the static
  // import graph, completely skipping Vitest's own git lookup (Dev Notes: "the `related`
  // mechanism"). This is the SAME path for a source change and a test-only change alike -- there
  // is no more separate map-lookup-vs-static-graph split to choose between.
  if (opts.relatedFiles && opts.relatedFiles.length > 0) {
    const relatedAbsolute = opts.relatedFiles.map((f) => path.resolve(cwd, f));
    let inc: RunOnceResult | undefined;
    try {
      inc = await runOnce(
        startVitest,
        [],
        { related: relatedAbsolute },
        runId,
        onProgress,
        testTimeoutMs,
      );
    } catch {
      // A deleted/non-existent path in `related` resolves to zero matches (safe) rather than
      // throwing, but any exotic internal Vitest error must degrade to the full suite, never fail
      // the run (invariant 5) -- mirrors the old `--changed` branch's try/catch. Falls through to
      // the same full-suite fallback the zero-match path uses below.
      inc = undefined;
    }
    if (inc && inc.modules.length > 0) {
      return build(inc, {
        strategy: "incremental",
        reason: "related-based selection (Vitest static import graph)",
      });
    }
    // `related` resolved to zero actual test files despite non-empty changed input (e.g. a
    // genuine orphan source nothing statically depends on), or the related pass threw -> never
    // silently report "0 passed": fall back to the full suite as a second Vitest pass.
    const full = await runOnce(startVitest, [], {}, runId, onProgress, testTimeoutMs);
    return build(full, {
      strategy: "full",
      reason: "incremental selection matched no test files; ran full suite",
    });
  }

  // Full run, or an explicit file selection.
  const run = await runOnce(startVitest, opts.files, {}, runId, onProgress, testTimeoutMs);
  if (opts.files.length > 0 && run.modules.length === 0) {
    // A selection that resolves to zero actual test files (e.g. a stale/renamed explicit file
    // name) must never silently report "0 passed" — escalate to the full suite (mirrors the
    // related-based branch's identical safety net above).
    const full = await runOnce(startVitest, [], {}, runId, onProgress, testTimeoutMs);
    return build(full, {
      strategy: "full",
      reason: "incremental selection matched no test files; ran full suite",
    });
  }
  return build(run, {
    strategy: opts.files.length ? "incremental" : "full",
    reason: opts.files.length ? "explicit file selection" : "full suite",
  });
}

/**
 * Read the project's configured Vitest `coverage.thresholds` (Story 6.3 AC4) and its resolved
 * `testTimeout` (Story 8.2 -- the stall watchdog's threshold) from a single lightweight
 * `createVitest` discovery instance, without running or enabling coverage. Best-effort — any
 * failure yields both fields `undefined` (no gate, watchdog falls back to its lenient default).
 */
async function readResolvedRunConfig(
  createVitest: VitestNode["createVitest"],
): Promise<{ testTimeoutMs?: number; coverageThresholds?: unknown }> {
  try {
    const vitest = await createVitest("test", { watch: false });
    try {
      return {
        testTimeoutMs:
          typeof vitest.config?.testTimeout === "number" ? vitest.config.testTimeout : undefined,
        coverageThresholds: vitest.config?.coverage?.thresholds,
      };
    } finally {
      await vitest.close();
    }
  } catch {
    return {};
  }
}

// Story 3.8 retired the old two-phase design ("run once for results, then run again per test
// file to build a source->test reverse map") entirely. Coverage is now produced by ONE unified
// Vitest pass that measures results AND coverage in the SAME invocation -- see `runWithCoverage`
// below. There is no more separate coverage phase, no more reverse map, no more per-file
// measurement, and (per AC2) no more incremental/selective coverage at all -- coverage is
// full-suite-only now.

/** Coerce an istanbul pct (0-100) to a finite number; a non-numeric sentinel becomes 0. */
function pct(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Convert a single (full-suite or, defensively, explicit-file) `coverage-final.json` directly
 * into `TestResult["coverage"]` (Story 3.7, shape simplified further in Story 3.8) -- every file
 * was freshly measured in this exact pass, so there is no staleness concept and no per-test union
 * to perform; the retired combined-coverage report (Story 6.10) used to carry `fresh`/`stale`
 * flags for exactly that union case, which no longer exists.
 */
function buildNativeCoverageReport(
  json: Record<string, unknown>,
  projectRoot: string,
  rawThresholds: unknown,
): NonNullable<TestResult["coverage"]> {
  const map = libCoverage.createCoverageMap(json as libCoverage.CoverageMapData);
  const files: Array<{ file: string } & CoveragePct> = [];
  const total = libCoverage.createCoverageSummary();
  for (const abs of map.files()) {
    const rel = path.relative(projectRoot, abs);
    if (
      rel.startsWith("..") ||
      path.isAbsolute(rel) || // Windows: different drive -> path.relative returns an absolute path
      rel.split(path.sep).includes("node_modules") ||
      isTestFile(rel)
    ) {
      continue;
    }
    const summary = map.fileCoverageFor(abs).toSummary();
    total.merge(summary);
    files.push({
      file: rel,
      statements: pct(summary.data.statements.pct),
      branches: pct(summary.data.branches.pct),
      functions: pct(summary.data.functions.pct),
      lines: pct(summary.data.lines.pct),
    });
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const totalPct: CoveragePct = {
    statements: pct(total.data.statements.pct),
    branches: pct(total.data.branches.pct),
    functions: pct(total.data.functions.pct),
    lines: pct(total.data.lines.pct),
  };
  const parsedThresholds = parseGlobalThresholds(rawThresholds) ?? undefined;
  const thresholdsMet = parsedThresholds ? meetsThresholds(totalPct, parsedThresholds) : undefined;

  return {
    total: totalPct,
    files,
    confidence: { level: "high", reasons: [] },
    ...(parsedThresholds ? { thresholds: parsedThresholds } : {}),
    ...(thresholdsMet !== undefined ? { thresholdsMet } : {}),
  };
}

/**
 * Unified single-pass coverage measurement (Story 3.8): the SAME Vitest invocation that produces
 * real test results also measures coverage (`coverage.enabled: true` merged into `runOnce`'s
 * `extraOptions` -- already-proven shallow-merge support, Story 3.7's `buildNativeFullSuiteCoverage`
 * used the same shape for a standalone call; here it's the SAME call that also produces results,
 * not a second one). Only ever called for a genuine full-suite request -- `msg.coverage` is only
 * ever true when the orchestrator has already validated `sel.strategy === "full"` (Task 3.2's
 * `SelectionError` check) -- so `filters` here is always `[]` in production; it is threaded
 * through anyway so this function's own contract doesn't silently assume that rather than stating
 * it. Logs at entry and at each silent-degrade branch (missing file, corrupt JSON) -- Story 3.7
 * shipped its equivalent with zero diagnostic logging, which is exactly what caused this story's
 * second reported symptom (a real run's coverage report went silently missing with no trace in
 * `debug-memory.log`); this does not repeat that gap.
 */
async function runWithCoverage(
  cwd: string,
  filters: string[],
  runId: string,
  thresholds: unknown,
  onProgress: (completed: number, total: number) => void,
  testTimeoutMs: number | undefined,
  startVitest: VitestNode["startVitest"],
): Promise<{ result: TestResult; failureDetails: FailureDetail[] }> {
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cov-"));
  logMemory(cwd, "unified-coverage-start", { filters: filters.length });
  try {
    // Wrap the coverage pass in the tail heartbeat: redundant during the test phase (real
    // progress already arms the watchdog there) but essential during the silent coverage
    // generation that follows the last test module.
    const r = await withCoverageTailHeartbeat(runId, testTimeoutMs, () =>
      runOnce(
        startVitest,
        filters,
        {
          coverage: {
            enabled: true,
            // Forced, matching this codebase's long-standing choice (Story 3.7) regardless of what
            // a project's own vitest.config names -- buildNativeCoverageReport below parses the
            // v8/istanbul-shaped coverage-final.json output directly.
            provider: "v8",
            // Only files at least one test actually touched (not every file in the project) --
            // matches every other coverage report this codebase has ever produced; broadening this
            // would be a new, stricter guarantee this story was never asked to add.
            all: false,
            reporter: ["json"],
            reportsDirectory: reportsDir,
            // Never let Vitest's own threshold gate run/exit on this pass -- thresholdsMet is
            // computed manually below via meetsThresholds(), so a failing threshold can never
            // abort the run.
            thresholds: undefined,
          },
        },
        runId,
        onProgress,
        testTimeoutMs,
      ),
    );
    const selection: { strategy: "full" | "incremental"; reason: string } = filters.length
      ? { strategy: "incremental", reason: "explicit file selection" }
      : { strategy: "full", reason: "full suite" };
    const built = {
      result: mapModulesToResult(r.modules, r.unhandled, r.wallClockMs, selection, r.isolate),
      failureDetails: mapFailureDetails(r.modules, r.unhandled),
    };
    const covFile = path.join(reportsDir, "coverage-final.json");
    if (!fs.existsSync(covFile)) {
      logMemory(cwd, "unified-coverage-missing-file", { reportsDir });
      return built;
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(fs.readFileSync(covFile, "utf8")) as Record<string, unknown>;
    } catch (err) {
      // A truncated/corrupt coverage-final.json (killed mid-write, disk full) must degrade to "no
      // coverage this run," never throw and take the whole (already-successful) run result down.
      logMemory(cwd, "unified-coverage-corrupt-json", {
        error: err instanceof Error ? err.message : String(err),
      });
      return built;
    }
    const coverage = buildNativeCoverageReport(json, cwd, thresholds);
    logMemory(cwd, "unified-coverage-done", { files: coverage.files.length });
    return { ...built, result: { ...built.result, coverage } };
  } finally {
    fs.rmSync(reportsDir, { recursive: true, force: true });
  }
}

/** Run tests, measuring coverage in the same pass when requested (Story 3.8: exactly one Vitest
 *  invocation either way -- never a separate results-then-coverage two-phase run). */
async function handleRun(
  msg: Extract<ToWorker, { type: "run" }>,
): Promise<{ result: TestResult; failureDetails: FailureDetail[] }> {
  const cwd = process.cwd();
  // Unconditional (fires regardless of msg.coverage) -- confirms this worker is actually running
  // the instrumented build, and whether coverage was even requested for this run, before anything
  // else can go wrong.
  logMemory(cwd, "handle-run-start", {
    coverageRequested: !!msg.coverage,
    filesRequested: msg.files.length,
    workerPid: process.pid,
  });
  const projectRequire = createRequire(path.join(cwd, "__test-mcp-resolve__.js"));
  const { createVitest, startVitest } = projectRequire("vitest/node") as VitestNode;

  // Read resolved config BEFORE the real run so the orchestrator's stall watchdog (Story 8.5)
  // can be armed with the project's actual testTimeout from the start, not just its fallback.
  const { testTimeoutMs, coverageThresholds } = await readResolvedRunConfig(createVitest);
  if (testTimeoutMs !== undefined) {
    send({ type: "config", runId: msg.runId, testTimeoutMs });
  }

  const onProgress = (completed: number, total: number): void =>
    send({ type: "progress", runId: msg.runId, completed, total });

  if (msg.coverage) {
    // Only ever true for a genuine full-suite request (validated at the orchestrator, Task 3.2)
    // -- the SAME single Vitest pass that produces real results also measures coverage; there is
    // no more separate coverage phase to run afterward (AC1: exactly one Vitest invocation).
    return runWithCoverage(cwd, msg.files, msg.runId, coverageThresholds, onProgress, testTimeoutMs, startVitest);
  }
  return runVitest(cwd, { files: msg.files, relatedFiles: msg.relatedFiles }, msg.runId, onProgress, testTimeoutMs);
}

function send(msg: FromWorker): void {
  process.send?.(msg);
}

// Only wire IPC when actually forked (process.send is defined in a child with an IPC channel).
if (process.send) {
  process.on("message", (raw: unknown) => {
    let msg: ToWorker;
    try {
      msg = parseToWorker(raw);
    } catch (e) {
      // A malformed message crossing the IPC edge is ignored (logged to the daemon's stderr)
      // rather than acted on with garbage fields.
      process.stderr.write(
        `test-mcp worker: ignoring invalid IPC message: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return;
    }
    if (msg.type === "run") {
      handleRun(msg)
        .then(({ result, failureDetails }) =>
          send({ type: "result", runId: msg.runId, result, failureDetails }),
        )
        .catch((err: unknown) =>
          send({
            type: "error",
            runId: msg.runId,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          }),
        );
    } else if (msg.type === "shutdown") {
      process.exit(0);
    }
    // "cancel" is not implemented in Story 2.1.
  });
  send({ type: "ready" });
}
