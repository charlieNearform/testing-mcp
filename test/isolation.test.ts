import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const isolationProject = path.join(repoRoot, "test-fixtures", "isolation-project");
const noIsolationProject = path.join(repoRoot, "test-fixtures", "no-isolation-project");

describe("test isolation", () => {
  it("runs each file in a fresh context under isolate:true and reports isolate=true", async () => {
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "iso", path: isolationProject });
    // Both files' counters start at 1 => no cross-file leak.
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.success).toBe(true);
    expect(result.metadata?.isolate).toBe(true);
  }, 60_000);

  it("reports isolate=false when the project disables isolation", async () => {
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "noiso", path: noIsolationProject });
    expect(result.metadata?.isolate).toBe(false);
  }, 60_000);
});
