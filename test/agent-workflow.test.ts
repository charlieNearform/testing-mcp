import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const fixture = { projectId: "wf-fixture", path: path.join(repoRoot, "test-fixtures", "sample-project") };

describe("status, progress & minimal output (Stories 4.2 / 4.3)", () => {
  it("tracks run state, emits status changes and progress, and returns failure-forward output", async () => {
    const orch = new Orchestrator({ workerPath });

    expect(orch.getRunStatus("wf-fixture").state).toBe("idle");

    const states: string[] = [];
    const unsub = orch.onStatusChange(() => states.push(orch.getRunStatus("wf-fixture").state));

    const progress: Array<{ completed: number; total: number }> = [];
    const result = await orch.runTests(fixture, {
      onProgress: (completed, total) => progress.push({ completed, total }),
    });
    unsub();

    // Status machine reached running then complete.
    expect(states).toContain("running");
    expect(states).toContain("complete");
    expect(orch.getRunStatus("wf-fixture").state).toBe("complete");
    expect(orch.getRunStatus("wf-fixture").lastResult?.total).toBe(2);

    // Progress was emitted with a known total.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)!.total).toBeGreaterThan(0);

    // Minimal, failure-forward summary (Story 4.3): counts + foregrounds the failure.
    expect(result.summary).toContain("FAILED");
    expect(result.failed).toBe(1);
    // Compact failures carry no stack; full detail is available on demand.
    const failing = result.failures[0];
    expect(failing).not.toHaveProperty("stack");
    const detail = orch.getFailureDetail("wf-fixture", failing.id);
    expect(detail).toBeTruthy();
  }, 60_000);
});
