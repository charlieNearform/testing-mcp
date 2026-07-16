import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, WorkerError } from "../src/orchestrator/index.ts";

// The blocking-worker fixture signals "started" then blocks until a "release" file appears
// (see test-fixtures/blocking-worker/worker.mjs) -- perfect for proving a timer does/doesn't
// fire without actually waiting out a real multi-minute timeout.
const workerPath = fileURLToPath(
  new URL("../test-fixtures/blocking-worker/worker.mjs", import.meta.url),
);

let root: string;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("Orchestrator run timeout (unbounded by default)", () => {
  it("never fires a timeout by default, even well past the old 120s hard-coded default's neighborhood", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-timeout-"));
    const stateDir = path.join(root, ".test-mcp");
    const startedPath = path.join(stateDir, "started");
    const releasePath = path.join(stateDir, "release");

    const orch = new Orchestrator({ workerPath }); // no runTimeoutMs -> no cap
    const pending = orch.runTests({ projectId: "unbounded", path: root }, { mode: "full" });

    for (let i = 0; i < 200 && !fs.existsSync(startedPath); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fs.existsSync(startedPath)).toBe(true);

    // A real 120s+ wait isn't practical here; this only proves the run is still outstanding
    // (not rejected) after a short window, which combined with the guard's own logic (only
    // schedules a timer when `runTimeoutMs` is set -- see `executeWorker` in orchestrator/index.ts)
    // and the companion test below (proving the SAME timer mechanism DOES fire when configured)
    // is the practical proof available without burning real CI minutes.
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(releasePath, "");

    const result = await pending;
    expect(result.success).toBe(true);
  }, 20_000);

  it("still fails fast with the existing WorkerError when an explicit small runTimeoutMs is set", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-timeout-cap-"));

    const orch = new Orchestrator({ workerPath, runTimeoutMs: 50 });
    const project = { projectId: "capped", path: root };

    const failure = await orch.runTests(project, { mode: "full" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WorkerError);
    expect((failure as WorkerError).message).toContain("worker timed out after 50ms");
    // No release-file cleanup needed here: `executeWorker`'s `finish()` already kills the child
    // as part of the same timeout path that produced this WorkerError.
  }, 20_000);
});
