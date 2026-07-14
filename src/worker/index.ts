import { createRequire } from "node:module";
import * as path from "node:path";
import type { TestResult, FailureDetail } from "../types/contracts.js";
import type { ToWorker, FromWorker } from "../types/ipc.js";

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
interface VitestNode {
  startVitest(
    mode: string,
    cliFilters: string[],
    options: Record<string, unknown>,
  ): Promise<{ close(): Promise<void> } | false>;
}

/** Convert captured Vitest reporter data into our TestResult contract. Pure — unit-testable. */
export function mapModulesToResult(
  modules: ReadonlyArray<VTestModule>,
  unhandled: ReadonlyArray<VError>,
  wallClockMs: number,
  requestedFiles: string[],
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
      strategy: "full",
      reason: requestedFiles.length ? "explicit file list" : "full suite (no selection engine yet)",
      files: filesRun,
    },
    metadata: {
      wallClockMs,
      testExecMs,
      overheadMs: Math.max(0, wallClockMs - testExecMs),
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

/** Resolve the PROJECT's Vitest and run it programmatically, returning result + failure details. */
export async function runVitest(
  cwd: string,
  files: string[],
): Promise<{ result: TestResult; failureDetails: FailureDetail[] }> {
  // Resolve vitest from the project's own node_modules (walks up from cwd).
  const projectRequire = createRequire(path.join(cwd, "__test-mcp-resolve__.js"));
  const { startVitest } = projectRequire("vitest/node") as VitestNode;

  let modules: ReadonlyArray<VTestModule> = [];
  let unhandled: ReadonlyArray<VError> = [];
  const reporter = {
    onTestRunEnd(testModules: ReadonlyArray<VTestModule>, unhandledErrors: ReadonlyArray<VError>) {
      modules = testModules;
      unhandled = unhandledErrors;
    },
  };

  const start = Date.now();
  const vitest = await startVitest("test", files, {
    watch: false,
    reporters: [reporter],
    coverage: { enabled: false },
  });
  const wallClockMs = Date.now() - start;
  if (!vitest) {
    throw new Error("Vitest failed to start");
  }
  try {
    return {
      result: mapModulesToResult(modules, unhandled, wallClockMs, files),
      failureDetails: mapFailureDetails(modules, unhandled),
    };
  } finally {
    await vitest.close();
  }
}

function send(msg: FromWorker): void {
  process.send?.(msg);
}

// Only wire IPC when actually forked (process.send is defined in a child with an IPC channel).
if (process.send) {
  process.on("message", (msg: ToWorker) => {
    if (msg.type === "run") {
      runVitest(process.cwd(), msg.files)
        .then(({ result, failureDetails }) => send({ type: "result", runId: msg.runId, result, failureDetails }))
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
