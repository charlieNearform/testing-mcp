import { describe, it, expect, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FromWorker } from "../src/types/ipc.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const fixture = path.join(repoRoot, "test-fixtures", "sample-project");

let child: ChildProcess | undefined;

afterEach(() => {
  if (child && !child.killed) child.kill();
  child = undefined;
  // The coverage-enabled test run writes real coverage-map/coverage-data files into this
  // SHARED, non-ephemeral fixture's .test-mcp/ -- other suites (e.g. worker-run.test.ts) assume
  // this fixture has no pre-existing coverage map, so this must never leak between test files.
  fs.rmSync(path.join(fixture, ".test-mcp", "coverage-map.json"), { force: true });
  fs.rmSync(path.join(fixture, ".test-mcp", "coverage-data.json"), { force: true });
});

/** Fork the real worker against the real sample-project fixture and collect every IPC message. */
function runWorker(coverage: boolean): Promise<FromWorker[]> {
  return new Promise((resolve, reject) => {
    child = fork(workerPath, [], { cwd: fixture, execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const runId = randomUUID();
    const messages: FromWorker[] = [];
    child.on("message", (raw: unknown) => {
      const msg = raw as FromWorker;
      messages.push(msg);
      if (msg.type === "ready") {
        child!.send({
          type: "run",
          runId,
          projectId: "sample",
          files: [],
          coverage,
        });
      } else if (msg.type === "result" || msg.type === "error") {
        resolve(messages);
      }
    });
    child.on("error", reject);
  });
}

describe("worker live-progress IPC (Story 8.2, real Vitest)", () => {
  it("sends a config message with the fixture's resolved testTimeout before the first progress/result", async () => {
    const messages = await runWorker(false);
    const configMsg = messages.find((m) => m.type === "config");
    expect(configMsg).toBeDefined();
    if (configMsg?.type !== "config") throw new Error("expected config message");
    // Fixture's vitest.config.ts doesn't set testTimeout -- Vitest 4.1.9's own default is 5000ms.
    expect(configMsg.testTimeoutMs).toBe(5000);

    const configIndex = messages.indexOf(configMsg);
    const firstProgressOrResult = messages.findIndex(
      (m) => m.type === "progress" || m.type === "result",
    );
    expect(configIndex).toBeLessThan(firstProgressOrResult);
  }, 30_000);

  it("sends case-start/case-result pairs for each known fixture test, with the right status", async () => {
    const messages = await runWorker(false);
    const starts = messages.filter((m): m is Extract<FromWorker, { type: "case-start" }> =>
      m.type === "case-start",
    );
    const results = messages.filter((m): m is Extract<FromWorker, { type: "case-result" }> =>
      m.type === "case-result",
    );

    const passing = results.find((m) => m.name === "addition works");
    const failing = results.find((m) => m.name === "intentional failure");
    expect(passing?.status).toBe("passed");
    expect(failing?.status).toBe("failed");

    // Every case-result name has a matching case-start.
    for (const r of results) {
      expect(starts.some((s) => s.name === r.name && s.file === r.file)).toBe(true);
    }
  }, 30_000);

  // Story 3.8: the unified single pass gets real per-test progress from the SAME reporter a
  // plain run uses -- there is no more separate blind coverage phase needing a synthetic
  // heartbeat (the "phase-progress" IPC message this test used to assert on is deleted). This
  // fixture's own node_modules has no coverage provider installed (unlike the symlinked-repo
  // fixtures worker-native-full-coverage.test.ts uses), so the actual coverage REPORT shape is
  // asserted there; this test only proves the coverage-enabled run still completes normally and
  // still reports real per-test progress through the same IPC messages as any other run.
  it("a coverage-enabled run still sends real case-start/case-result progress and a result", async () => {
    const messages = await runWorker(true);
    const starts = messages.filter((m): m is Extract<FromWorker, { type: "case-start" }> =>
      m.type === "case-start",
    );
    const results = messages.filter((m): m is Extract<FromWorker, { type: "case-result" }> =>
      m.type === "case-result",
    );
    expect(starts.length).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);

    const resultMsg = messages.find((m) => m.type === "result");
    expect(resultMsg?.type).toBe("result");
  }, 30_000);
});
