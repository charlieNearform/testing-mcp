import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, WorkerError } from "../src/orchestrator/index.ts";

// The blocking-worker fixture signals "started" then blocks until "release" appears, and
// supports one-shot sentinel-file triggers (send-config/send-case-start/send-case-result) so
// these tests can drive the watchdog's signals precisely without waiting out a real timeout.
const workerPath = fileURLToPath(
  new URL("../test-fixtures/blocking-worker/worker.mjs", import.meta.url),
);

let root: string;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function waitForStarted(stateDir: string): Promise<void> {
  const startedPath = path.join(stateDir, "started");
  for (let i = 0; i < 200 && !fs.existsSync(startedPath); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(fs.existsSync(startedPath)).toBe(true);
}

describe("Orchestrator stall watchdog (Story 8.5)", () => {
  it("fires on a true stall within the configured testTimeout + grace threshold", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-stall-"));
    const stateDir = path.join(root, ".test-mcp");

    const orch = new Orchestrator({ workerPath, staleTestGraceMs: 150 });
    const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    // Small testTimeout so threshold (testTimeout + grace) is well under the test's own timeout.
    fs.writeFileSync(path.join(stateDir, "send-config"), "150");

    const failure = await pending.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WorkerError);
    expect((failure as WorkerError).message).toContain("worker stalled: no test progress for");
  }, 20_000);

  it("does not fire while progress signals keep arriving (timer resets, not a fixed deadline)", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-stall-alive-"));
    const stateDir = path.join(root, ".test-mcp");

    const orch = new Orchestrator({ workerPath, staleTestGraceMs: 150 });
    const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    fs.writeFileSync(path.join(stateDir, "send-config"), "150"); // threshold = 300ms

    // Send a case-result every 80ms for 640ms (> 2x the threshold) -- if the timer didn't reset,
    // this would have stalled out long before we release.
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(stateDir, "send-case-result"),
        JSON.stringify({ file: "a.test.ts", name: `t${i}`, status: "passed" }),
      );
      await new Promise((r) => setTimeout(r, 80));
    }
    fs.writeFileSync(path.join(stateDir, "release"), "");
    const result = await pending;
    expect(result.success).toBe(true);
  }, 20_000);

  it("kills quickly (grace alone) if the worker never sends any message at all", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-stall-silent-"));
    const stateDir = path.join(root, ".test-mcp");

    // Nothing sent at all -- not even a `config` message -- proves the provisional watchdog
    // (AD-20: armed at `staleTestGraceMs` ALONE, before the worker has said anything) catches a
    // hang in the worker's own config-discovery step just as promptly as a later test-level stall.
    const orch = new Orchestrator({ workerPath, staleTestGraceMs: 150 });
    const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
    await waitForStarted(stateDir);

    const failure = await pending.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WorkerError);
    expect((failure as WorkerError).message).toContain("provisional grace");
  }, 20_000);

  it("falls back to the default-unknown-timeout threshold once ANY message has arrived, even without config", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-stall-noconfig-"));
    const stateDir = path.join(root, ".test-mcp");

    // A single case-result (no `config` message ever sent) proves the watchdog is demoted out of
    // its (short) provisional phase once the worker has said ANYTHING -- releasing well after the
    // 150ms provisional grace but comfortably before the real fallback threshold (the built-in
    // 5000ms default + grace) proves it isn't prematurely killed just because config is absent.
    const orch = new Orchestrator({ workerPath, staleTestGraceMs: 150 });
    const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "send-case-result"),
      JSON.stringify({ file: "a.test.ts", name: "t1", status: "passed" }),
    );
    await new Promise((r) => setTimeout(r, 400));
    fs.writeFileSync(path.join(stateDir, "release"), "");
    const result = await pending;
    expect(result.success).toBe(true);
  }, 20_000);

  it("produces a message distinguishable from the runTimeoutMs whole-run cap", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-stall-vs-timeout-"));
    const stateDir = path.join(root, ".test-mcp");

    // A tiny runTimeoutMs AND a tiny stall threshold both configured; releasing never (stall
    // fires first since it's the same order of magnitude but keyed off progress, not wall clock)
    // -- what matters here is the message text, not which one wins a race.
    const orch = new Orchestrator({ workerPath, staleTestGraceMs: 100 });
    const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    fs.writeFileSync(path.join(stateDir, "send-config"), "50"); // threshold = 150ms

    const failure = await pending.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WorkerError);
    expect((failure as WorkerError).message).toContain("stalled");
    expect((failure as WorkerError).message).not.toContain("timed out after");
  }, 20_000);
});
