import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

const workerPath = fileURLToPath(
  new URL("../test-fixtures/blocking-worker/worker.mjs", import.meta.url),
);

async function poll(predicate: () => boolean, tries = 200, intervalMs = 10): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

describe("global worker concurrency cap", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-conc-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not fork a second project's worker while at maxConcurrentWorkers=1", async () => {
    const dirA = path.join(root, "a");
    const dirB = path.join(root, "b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const started = (dir: string) => fs.existsSync(path.join(dir, ".test-mcp", "started"));
    const release = (dir: string) =>
      fs.writeFileSync(path.join(dir, ".test-mcp", "release"), "");

    const orch = new Orchestrator({ workerPath, maxConcurrentWorkers: 1 });
    const pA = orch.runTests({ projectId: "capA", path: dirA }, { mode: "full" });
    const pB = orch.runTests({ projectId: "capB", path: dirB }, { mode: "full" });

    // A takes the only slot and forks.
    expect(await poll(() => started(dirA))).toBe(true);
    // B must wait on the semaphore — its worker must NOT have started yet.
    await new Promise((r) => setTimeout(r, 200));
    expect(started(dirB)).toBe(false);

    // Release A; the freed slot lets B start.
    release(dirA);
    await pA;
    expect(await poll(() => started(dirB))).toBe(true);
    release(dirB);
    await pB;
  }, 20_000);
});
