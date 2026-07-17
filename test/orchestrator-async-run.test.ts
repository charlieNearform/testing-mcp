import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

const workerPath = fileURLToPath(
  new URL("../test-fixtures/blocking-worker/worker.mjs", import.meta.url),
);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

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

describe("Orchestrator.startRun (Story 8.4)", () => {
  it("returns a runId synchronously, before the run settles", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-startrun-"));
    const stateDir = path.join(root, ".test-mcp");
    const releasePath = path.join(stateDir, "release");

    const orch = new Orchestrator({ workerPath });
    const { runId, result } = orch.startRun({ projectId: "p", path: root }, { mode: "full" });
    expect(runId).toBeTruthy();

    await waitForStarted(stateDir);
    expect(fs.readFileSync(path.join(stateDir, "started"), "utf8")).toBe(runId); // same id reached the worker

    fs.writeFileSync(releasePath, "");
    const finalResult = await result;
    expect(finalResult.success).toBe(true);
  }, 20_000);

  it("runTests() is a thin wrapper: same resolved TestResult as before (no behavior change)", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-runtests-wrap-"));
    const stateDir = path.join(root, ".test-mcp");
    const orch = new Orchestrator({ workerPath });
    const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    fs.writeFileSync(path.join(stateDir, "release"), "");
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.total).toBe(1);
  }, 20_000);

  it("the empty-selection short-circuit's RunStatus.runId matches its persisted RunRecord.runId", async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-empty-runid-")));
    fs.writeFileSync(path.join(root, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, env: GIT_ENV });

    const orch = new Orchestrator({ workerPath });
    const project = { projectId: "p", path: root };
    const plan = orch.plan(project, { mode: "incremental" }); // no changes since commit -> empty plan
    const { runId, result } = orch.startPlanRun(project, plan.planId);

    const finalResult = await result; // empty short-circuit resolves without dispatching a worker
    expect(finalResult.total).toBe(0);
    expect(orch.getRunStatus("p").runId).toBe(runId);
    const history = orch.getRunHistory("p");
    expect(history[0]?.runId).toBe(runId);
  }, 20_000);

  it("startPlanRun still throws PlanError synchronously for an expired/unknown plan (no runId minted)", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-plan-expired-"));
    const orch = new Orchestrator({ workerPath });
    expect(() => orch.startPlanRun({ projectId: "p", path: root }, "does-not-exist")).toThrow(
      /expired or unknown/,
    );
  });
});
