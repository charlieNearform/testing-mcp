import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const fixture = path.join(repoRoot, "test-fixtures", "sample-project");

describe("Orchestrator.runTests (project-local worker)", () => {
  it("runs the project's own vitest and returns structured results with overhead metadata", async () => {
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "fixture", path: fixture });
    expect(result.total).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.success).toBe(false);
    expect(result.failures.some((f) => f.name.includes("intentional failure"))).toBe(true);
    expect(result.selection.strategy).toBe("full");
    expect(result.metadata?.wallClockMs).toBeGreaterThan(0);
    expect(result.metadata?.testExecMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata?.overheadMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata!.wallClockMs).toBeGreaterThanOrEqual(result.metadata!.testExecMs);
    // Story 6.1: the per-test list covers every case that ran (the passing one too, not just failures).
    expect(result.tests?.length).toBe(2);
    expect(result.tests?.some((t) => t.status === "passed")).toBe(true);
    expect(result.tests?.some((t) => t.status === "failed")).toBe(true);
  }, 60_000);

  it("returns WorkerFailure when vitest cannot be resolved, and stays healthy afterwards", async () => {
    const orch = new Orchestrator({ workerPath });
    // A project outside the repo tree => no ancestor node_modules => vitest/node cannot resolve.
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-novitest-"));
    fs.writeFileSync(path.join(broken, "vitest.config.ts"), "export default {};\n");
    await expect(
      orch.runTests({ projectId: "broken", path: broken }),
    ).rejects.toMatchObject({ code: "WorkerFailure" });
    fs.rmSync(broken, { recursive: true, force: true });

    // Orchestrator remains usable for a good project after a failure.
    const ok = await orch.runTests({ projectId: "fixture", path: fixture });
    expect(ok.passed).toBe(1);
  }, 60_000);
});
