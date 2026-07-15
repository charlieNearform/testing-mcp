import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, PlanError } from "../src/orchestrator/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const fixture = { projectId: "plan-fixture", path: path.join(repoRoot, "test-fixtures", "sample-project") };

describe("dry-run plan / commit (Story 4.1)", () => {
  it("returns a TestPlan without executing, then commits it exactly", async () => {
    const orch = new Orchestrator({ workerPath });

    const plan = orch.plan(fixture, {});
    expect(plan.planId).toBeTruthy();
    expect(plan.projectId).toBe("plan-fixture");
    expect(plan.strategy).toBe("full");
    expect(plan.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    expect(new Date(plan.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // Dry-run does not execute: run state stays idle.
    expect(orch.getRunStatus("plan-fixture").state).toBe("idle");

    const result = await orch.runPlan(fixture, plan.planId);
    expect(result.total).toBe(2);
  }, 60_000);

  it("rejects an unknown planId with PlanError", async () => {
    const orch = new Orchestrator({ workerPath });
    await expect(orch.runPlan(fixture, "nope")).rejects.toBeInstanceOf(PlanError);
  });

  it("rejects a consumed planId (one-shot commit)", async () => {
    const orch = new Orchestrator({ workerPath });
    const plan = orch.plan(fixture, {});
    await orch.runPlan(fixture, plan.planId);
    await expect(orch.runPlan(fixture, plan.planId)).rejects.toBeInstanceOf(PlanError);
  }, 60_000);

  it("rejects an expired plan (PlanExpired path)", async () => {
    const orch = new Orchestrator({ workerPath, planTtlMs: 5 });
    const plan = orch.plan(fixture, {});
    await new Promise((r) => setTimeout(r, 20));
    await expect(orch.runPlan(fixture, plan.planId)).rejects.toBeInstanceOf(PlanError);
  });
});
