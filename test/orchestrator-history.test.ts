import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const fixture = { projectId: "history-fixture", path: path.join(repoRoot, "test-fixtures", "sample-project") };

describe("orchestrator run history", () => {
  it("records completed runs, newest first, and looks one up by id", async () => {
    const orch = new Orchestrator({ workerPath });

    expect(orch.getRunHistory(fixture.projectId)).toEqual([]);

    await orch.runTests(fixture, { mode: "full" });
    await orch.runTests(fixture, { mode: "full" });

    const history = orch.getRunHistory(fixture.projectId);
    expect(history).toHaveLength(2);
    // Each record carries the result (selection + counts) and a runId.
    const latest = history[0];
    expect(latest.status).toBe("complete");
    expect(latest.result?.total).toBe(2);
    expect(latest.runId).toBeTruthy();
    // Lookup by id returns the same record.
    expect(orch.getRun(fixture.projectId, latest.runId)).toBe(latest);
    // Unknown id -> undefined.
    expect(orch.getRun(fixture.projectId, "missing")).toBeUndefined();
  }, 60_000);
});
