import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { TestResult, FailureDetail } from "../types/contracts.js";
import { parseToWorker, type ToWorker, type FromWorker, type CoverageDelta } from "../types/ipc.js";
import {
  buildCoverageMap,
  extractCoveredSources,
  loadCoverageMap,
  saveCoverageMap,
  type FileMeasurement,
} from "../coverage/index.js";
import {
  loadCoverageData,
  saveCoverageData,
  updateCoverageData,
  combineCoverage,
  coveredSourceFiles,
  type IstanbulCoverageData,
  type TestCoverage,
} from "../coverage/combined.js";
import { computeHashes } from "../snapshot/index.js";

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
  /** Resolved config — we read the project's coverage thresholds for the gate (Story 6.3 AC4). */
  config?: { coverage?: { thresholds?: unknown } };
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

/** Execute Vitest once with the given filters/options and capture reporter output. */
async function runOnce(
  startVitest: VitestNode["startVitest"],
  filters: string[],
  extraOptions: Record<string, unknown>,
  onProgress?: (completed: number, total: number) => void,
): Promise<RunOnceResult> {
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
  };
  const start = Date.now();
  const vitest = await startVitest("test", filters, {
    watch: false,
    reporters: [reporter],
    coverage: { enabled: false },
    ...extraOptions,
  });
  const wallClockMs = Date.now() - start;
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
  const counts = `${passed}/${total} passed, ${failed} failed, ${skipped} skipped (${wallClockMs}ms)`;
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
  opts: { files: string[]; changed: boolean },
  onProgress?: (completed: number, total: number) => void,
): Promise<{ result: TestResult; failureDetails: FailureDetail[] }> {
  const projectRequire = createRequire(path.join(cwd, "__test-mcp-resolve__.js"));
  const { startVitest } = projectRequire("vitest/node") as VitestNode;

  const build = (
    r: RunOnceResult,
    selection: { strategy: "full" | "incremental"; reason: string },
  ) => ({
    result: mapModulesToResult(r.modules, r.unhandled, r.wallClockMs, selection, r.isolate),
    failureDetails: mapFailureDetails(r.modules, r.unhandled),
  });

  // Union (Story 3.5): an explicit coverage-map selection PLUS the git static-graph (--changed),
  // merged so we run everything either signal deems affected.
  if (opts.changed && opts.files.length > 0) {
    const primary = await runOnce(startVitest, opts.files, {}, onProgress);
    let staticRun: RunOnceResult | null = null;
    try {
      staticRun = await runOnce(startVitest, [], { changed: true });
    } catch {
      // Not a git repo / --changed unusable -> union is just the coverage-map selection.
      staticRun = null;
    }
    const byId = new Map<string, VTestModule>();
    for (const m of [...primary.modules, ...(staticRun?.modules ?? [])]) {
      if (!byId.has(m.moduleId)) byId.set(m.moduleId, m);
    }
    const mergedModules = [...byId.values()];
    // Both signals selected zero test files for a change we were told exists -> never silently
    // report "0 passed" (a silent skip). Fall back to the full suite, matching the lone `--changed`
    // branch below (Story 6.8; closes the 6.6 union-branch gap).
    if (mergedModules.length === 0) {
      const full = await runOnce(startVitest, [], {}, onProgress);
      return build(full, {
        strategy: "full",
        reason: "incremental selection matched no test files; ran full suite",
      });
    }
    const mergedUnhandled = [...primary.unhandled, ...(staticRun?.unhandled ?? [])];
    const wall = primary.wallClockMs + (staticRun?.wallClockMs ?? 0);
    return {
      result: mapModulesToResult(
        mergedModules,
        mergedUnhandled,
        wall,
        { strategy: "incremental", reason: "coverage-map selection unioned with git static-graph" },
        primary.isolate,
      ),
      failureDetails: mapFailureDetails(mergedModules, mergedUnhandled),
    };
  }

  // Incremental (git-aware) selection — only when the caller did not pin explicit files.
  if (opts.changed && opts.files.length === 0) {
    try {
      const inc = await runOnce(startVitest, [], { changed: true }, onProgress);
      if (inc.modules.length > 0) {
        return build(inc, {
          strategy: "incremental",
          reason: "git delta via vitest --changed (static import graph)",
        });
      }
      // No affected test files -> fall through to a full run (never a silent skip).
    } catch {
      // Not a git repo / --changed unusable -> fall through to a full run.
    }
    const full = await runOnce(startVitest, [], {}, onProgress);
    return build(full, {
      strategy: "full",
      reason: "incremental found no affected tests (unmapped change or non-git); ran full suite",
    });
  }

  // Full run, or an explicit file selection.
  const run = await runOnce(startVitest, opts.files, {}, onProgress);
  return build(run, {
    strategy: opts.files.length ? "incremental" : "full",
    reason: opts.files.length ? "explicit file selection" : "full suite",
  });
}

/** Measure the source files reached purely by setupFiles (a no-op test triggers only setup). */
async function measureSetupBaseline(
  startVitest: VitestNode["startVitest"],
  projectRoot: string,
): Promise<string[]> {
  const baselineTest = path.join(projectRoot, "__test-mcp-baseline__.test.ts");
  fs.writeFileSync(baselineTest, `import { test } from "vitest";\ntest("baseline", () => {});\n`);
  try {
    const { sources, measured } = await measureCoverage(startVitest, projectRoot, baselineTest);
    return measured ? sources : [];
  } finally {
    fs.rmSync(baselineTest, { force: true });
  }
}

/** Measure one test file's coverage by running the project's Vitest with V8 coverage. */
async function measureCoverage(
  startVitest: VitestNode["startVitest"],
  projectRoot: string,
  absTestFile: string,
): Promise<FileMeasurement> {
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cov-"));
  try {
    const vitest = await startVitest("test", [absTestFile], {
      watch: false,
      // Keep reporters quiet; we only care about the coverage output on disk.
      reporters: [{}],
      coverage: {
        enabled: true,
        provider: "v8",
        all: false,
        reporter: ["json"],
        reportsDirectory: reportsDir,
        // A single-file run trips project coverage thresholds; never fail the build on them.
        thresholds: undefined,
      },
    });
    if (!vitest) return { sources: [], measured: false };
    try {
      const covFile = path.join(reportsDir, "coverage-final.json");
      if (!fs.existsSync(covFile)) return { sources: [], measured: false };
      const json = JSON.parse(fs.readFileSync(covFile, "utf8")) as Record<
        string,
        { s?: Record<string, number> }
      >;
      // Return the raw istanbul-shaped data too (Story 6.10) for the combined-coverage merge.
      return {
        sources: extractCoveredSources(json, projectRoot, absTestFile),
        measured: true,
        data: json as Record<string, unknown>,
      };
    } finally {
      await vitest.close();
    }
  } finally {
    fs.rmSync(reportsDir, { recursive: true, force: true });
  }
}

/** Discover all test files in the project (absolute paths) without running them. */
async function discoverTestFiles(createVitest: VitestNode["createVitest"]): Promise<string[]> {
  const vitest = await createVitest("test", { watch: false });
  try {
    const specs = await vitest.globTestSpecifications();
    return [...new Set(specs.map((s) => s.moduleId))];
  } finally {
    await vitest.close();
  }
}

/**
 * Read the project's configured Vitest `coverage.thresholds` (Story 6.3 AC4) from resolved config,
 * without running or enabling coverage. Best-effort — any failure yields `undefined` (no gate).
 */
async function readCoverageThresholds(
  createVitest: VitestNode["createVitest"],
): Promise<unknown> {
  try {
    const vitest = await createVitest("test", { watch: false });
    try {
      return vitest.config?.coverage?.thresholds;
    } finally {
      await vitest.close();
    }
  } catch {
    return undefined;
  }
}

/** Resolve `p`, or `fallback` if it doesn't settle within `ms`. The abandoned promise is left to
 *  settle on its own (its own finally cleans up); we never hang the whole build on one file. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Build/update and persist the reverse coverage map for this run AND refresh the per-test coverage
 * data behind the combined report (Story 6.10). Full when no explicit files were given; incremental
 * (only the given test files re-measured) when a file list was provided and a map already exists.
 * Returns the map summary plus the COMBINED whole-project coverage (union of each test file's latest
 * measurement) — derived from the SAME per-file measurement runs, so no extra suite execution.
 */
async function buildAndPersistCoverageMap(
  cwd: string,
  projectId: string,
  files: string[],
): Promise<{ delta: CoverageDelta; coverage?: TestResult["coverage"] }> {
  const projectRequire = createRequire(path.join(cwd, "__test-mcp-resolve__.js"));
  const { startVitest, createVitest } = projectRequire("vitest/node") as VitestNode;

  const targetTestFiles =
    files.length > 0
      ? files.map((f) => path.resolve(cwd, f))
      : await discoverTestFiles(createVitest);

  // The project's own coverage thresholds for the gate (Story 6.3 AC4) — read, never invented.
  const thresholds = await readCoverageThresholds(createVitest);
  const baseline = await measureSetupBaseline(startVitest, cwd);
  const budgetMs = Number(process.env.TEST_MCP_MEASURE_BUDGET_MS ?? 120_000);

  // Capture each measured test file's raw coverage data + the sources it touched as we go.
  const rawData: Record<string, IstanbulCoverageData> = {};
  const perTestSources: Record<string, string[]> = {};
  const freshSources = new Set<string>();
  const { file, summary } = await buildCoverageMap({
    projectRoot: cwd,
    projectId,
    targetTestFiles,
    existing: loadCoverageMap(cwd),
    measure: async (abs) => {
      const m = await withTimeout(measureCoverage(startVitest, cwd, abs), budgetMs, {
        sources: [],
        measured: false,
      });
      if (m.measured && m.data) {
        const testRel = path.relative(cwd, abs);
        rawData[testRel] = m.data as IstanbulCoverageData;
        // Every project source in the data, INCLUDING zero-hit ones, so a loaded-but-unexecuted
        // file still gets a measurement hash (else it would look permanently stale — review F2).
        const sources = coveredSourceFiles(m.data as IstanbulCoverageData, cwd);
        perTestSources[testRel] = sources;
        for (const s of sources) freshSources.add(s);
      }
      return m;
    },
    baseline,
  });
  saveCoverageMap(cwd, file);

  const coverage = persistAndCombine(cwd, projectId, rawData, perTestSources, freshSources, thresholds);
  return { delta: { ...summary }, coverage };
}

/**
 * Refresh the persisted per-test coverage data with this run's measurements, then merge every test
 * file's latest coverage into the combined whole-project report (Story 6.10). Best-effort: any
 * failure returns `undefined` (logged) so a coverage-report problem never fails the run.
 */
function persistAndCombine(
  cwd: string,
  projectId: string,
  rawData: Record<string, IstanbulCoverageData>,
  perTestSources: Record<string, string[]>,
  freshSources: ReadonlySet<string>,
  thresholds: unknown,
): TestResult["coverage"] | undefined {
  try {
    const now = new Date().toISOString();
    // Hash the sources measured this run once; record per-test which version each test saw, so a
    // later edit (or two tests that measured different versions) surfaces as stale (review F1).
    const freshHashes = computeHashes(cwd, [...freshSources]);
    const measured: Record<string, TestCoverage> = {};
    for (const [testRel, data] of Object.entries(rawData)) {
      const sourceHashes: Record<string, string> = {};
      for (const s of perTestSources[testRel] ?? []) {
        if (freshHashes[s] !== undefined) sourceHashes[s] = freshHashes[s];
      }
      measured[testRel] = { measuredAt: now, sourceHashes, data };
    }
    const existsTest = (testRel: string): boolean => fs.existsSync(path.join(cwd, testRel));
    const updated = updateCoverageData(loadCoverageData(cwd), projectId, now, measured, existsTest);
    saveCoverageData(cwd, updated);
    // Current hashes of every source any surviving test measured — to detect stale (changed) sources.
    const allSources = new Set<string>();
    for (const tc of Object.values(updated.tests)) {
      for (const s of Object.keys(tc.sourceHashes)) allSources.add(s);
    }
    const currentHashes = computeHashes(cwd, [...allSources]);
    return combineCoverage(updated, cwd, currentHashes, freshSources, thresholds) ?? undefined;
  } catch (err) {
    process.stderr.write(
      `[test-mcp] combined coverage unavailable this run: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return undefined;
  }
}

/** Run tests, and (when requested) build/persist the coverage map + combined report on the results. */
async function handleRun(
  msg: Extract<ToWorker, { type: "run" }>,
): Promise<{ result: TestResult; failureDetails: FailureDetail[]; coverageDelta?: CoverageDelta }> {
  const cwd = process.cwd();
  const base = await runVitest(cwd, { files: msg.files, changed: msg.changed }, (completed, total) =>
    send({ type: "progress", runId: msg.runId, completed, total }),
  );
  if (!msg.coverage) return base;
  const { delta, coverage } = await buildAndPersistCoverageMap(cwd, msg.projectId, msg.files);
  return {
    ...base,
    coverageDelta: delta,
    result: coverage ? { ...base.result, coverage } : base.result,
  };
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
        .then(({ result, failureDetails, coverageDelta }) =>
          send({ type: "result", runId: msg.runId, result, failureDetails, coverageDelta }),
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
