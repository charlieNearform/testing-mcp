import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { TestResult, FailureDetail } from "../types/contracts.js";
import type { ToWorker, FromWorker, CoverageDelta } from "../types/ipc.js";
import {
  buildCoverageMap,
  extractCoveredSources,
  loadCoverageMap,
  saveCoverageMap,
  type FileMeasurement,
} from "../coverage/index.js";

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

/** createVitest returns an instance we only use to discover test files. */
interface DiscoveryInstance {
  close(): Promise<void>;
  globTestSpecifications(): Promise<ReadonlyArray<{ moduleId: string }>>;
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
): Promise<RunOnceResult> {
  let modules: ReadonlyArray<VTestModule> = [];
  let unhandled: ReadonlyArray<VError> = [];
  const reporter = {
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
    }

    for (const tc of m.children.allTests()) {
      const r = tc.result();
      if (r.state === "passed") passed++;
      else if (r.state === "skipped") skipped++;
      else if (r.state === "failed") {
        failed++;
        failures.push({
          id: tc.id,
          name: tc.fullName,
          file: tc.module.moduleId,
          message: r.errors?.[0]?.message ?? "Test failed",
        });
      } else if (r.state === "pending") {
        failed++;
        failures.push({
          id: tc.id,
          name: tc.fullName,
          file: tc.module.moduleId,
          message: "Test still pending",
        });
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
  });

  const total = passed + failed + skipped;
  return {
    success: total > 0 && failed === 0,
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
    metadata: {
      wallClockMs,
      testExecMs,
      overheadMs: Math.max(0, wallClockMs - testExecMs),
      isolate,
    },
  };
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

  // Incremental (git-aware) selection — only when the caller did not pin explicit files.
  if (opts.changed && opts.files.length === 0) {
    try {
      const inc = await runOnce(startVitest, [], { changed: true });
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
    const full = await runOnce(startVitest, [], {});
    return build(full, {
      strategy: "full",
      reason: "incremental found no affected tests (unmapped change or non-git); ran full suite",
    });
  }

  // Full run, or an explicit file list.
  const run = await runOnce(startVitest, opts.files, {});
  return build(run, {
    strategy: "full",
    reason: opts.files.length ? "explicit file list" : "full suite",
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
      return { sources: extractCoveredSources(json, projectRoot, absTestFile), measured: true };
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
 * Build/update and persist the reverse coverage map for this run.
 * Full when no explicit files were given; incremental (only the given test files
 * re-measured) when a file list was provided and a map already exists.
 */
async function buildAndPersistCoverageMap(
  cwd: string,
  projectId: string,
  files: string[],
): Promise<CoverageDelta> {
  const projectRequire = createRequire(path.join(cwd, "__test-mcp-resolve__.js"));
  const { startVitest, createVitest } = projectRequire("vitest/node") as VitestNode;

  const targetTestFiles =
    files.length > 0
      ? files.map((f) => path.resolve(cwd, f))
      : await discoverTestFiles(createVitest);

  const baseline = await measureSetupBaseline(startVitest, cwd);
  const budgetMs = Number(process.env.TEST_MCP_MEASURE_BUDGET_MS ?? 120_000);
  const { file, summary } = await buildCoverageMap({
    projectRoot: cwd,
    projectId,
    targetTestFiles,
    existing: loadCoverageMap(cwd),
    measure: (abs) =>
      withTimeout(measureCoverage(startVitest, cwd, abs), budgetMs, { sources: [], measured: false }),
    baseline,
  });
  saveCoverageMap(cwd, file);
  return { ...summary };
}

/** Run tests, and (when requested) build/persist the coverage map on top of the results. */
async function handleRun(
  msg: Extract<ToWorker, { type: "run" }>,
): Promise<{ result: TestResult; failureDetails: FailureDetail[]; coverageDelta?: CoverageDelta }> {
  const cwd = process.cwd();
  const base = await runVitest(cwd, { files: msg.files, changed: msg.changed });
  if (!msg.coverage) return base;
  const coverageDelta = await buildAndPersistCoverageMap(cwd, msg.projectId, msg.files);
  return { ...base, coverageDelta };
}

function send(msg: FromWorker): void {
  process.send?.(msg);
}

// Only wire IPC when actually forked (process.send is defined in a child with an IPC channel).
if (process.send) {
  process.on("message", (msg: ToWorker) => {
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
