import { afterAll, afterEach, beforeAll, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Orchestrator } from "../src/orchestrator/index.ts";
import { COVERAGE_MAP_SCHEMA_VERSION } from "../src/coverage/index.ts";

/**
 * Story 6.4 — the orchestrator stamps its own resolved `reason`/`strategy` onto the
 * result, overriding the worker's generic labels, except at the git `--changed`
 * execution-time fallback. These tests drive the orchestrator with a stub worker so
 * the assertions turn purely on the stamp logic (no Vitest run), and on real git +
 * a hand-written coverage map so `resolveSelection` produces the decision we assert.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

// A fake worker: on "run" it returns the result the test staged at
// <TEST_MCP_STATE_DIR>/stub-result.json (the worker's own selection labels).
const STUB_WORKER = `import fs from "node:fs";
import path from "node:path";
const stateDir = process.env.TEST_MCP_STATE_DIR;
process.on("message", (msg) => {
  if (msg && msg.type === "run") {
    const result = JSON.parse(fs.readFileSync(path.join(stateDir, "stub-result.json"), "utf8"));
    process.send({ type: "result", runId: msg.runId, result });
  } else if (msg && msg.type === "shutdown") {
    process.exit(0);
  }
});
process.send({ type: "ready" });
`;

let workerDir: string;
let workerPath: string;
let proj: string | undefined;

beforeAll(() => {
  workerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-srworker-")));
  workerPath = path.join(workerDir, "worker.mjs");
  fs.writeFileSync(workerPath, STUB_WORKER);
});

afterAll(() => {
  fs.rmSync(workerDir, { recursive: true, force: true });
});

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
  proj = undefined;
});

function commitAll(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });
}

/** Stage the result the stub worker will return (its own execution-time selection labels). */
function stageWorkerResult(
  dir: string,
  selection: { strategy: "full" | "incremental"; reason: string; files: string[] },
): void {
  const stateDir = path.join(dir, ".test-mcp");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "stub-result.json"),
    JSON.stringify({
      success: true,
      summary: "2/2 passed, 0 failed, 0 skipped (1ms)",
      duration: 1,
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      failures: [],
      selection,
      metadata: { wallClockMs: 1, testExecMs: 1, overheadMs: 0, isolate: true },
    }),
  );
}

describe("orchestrator surfaces the real selection reason (Story 6.4)", () => {
  it("reports the orchestrator's specific full-decision reason, not the worker's 'full suite' (AC3)", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-sr-")));
    proj = dir;
    fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
    // A coverage map that knows math.ts but not the source we are about to add.
    fs.mkdirSync(path.join(dir, ".test-mcp"), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir, ".test-mcp", "coverage-map.json"),
      JSON.stringify({
        schemaVersion: COVERAGE_MAP_SCHEMA_VERSION,
        projectId: "sr",
        updatedAt: now,
        map: { "math.ts": { tests: ["math.test.ts"], lastMeasured: now } },
        fullSuiteTriggers: [],
        alwaysRun: [],
      }),
    );
    // Worker runs the full suite and labels it generically.
    stageWorkerResult(dir, { strategy: "full", reason: "full suite", files: ["math.test.ts"] });
    commitAll(dir);
    // A brand-new source the map has never seen — forces a full run for a specific reason.
    fs.writeFileSync(path.join(dir, "mystery.ts"), `export const x = 1;\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "sr", path: dir }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.selection.reason).toBe("changed source unknown to coverage map: mystery.ts");
    expect(result.selection.reason).not.toBe("full suite");
    // selection.files stays exactly what the worker ran — never rewritten.
    expect(result.selection.files).toEqual(["math.test.ts"]);
  }, 20_000);

  it("reports the resolved reason/strategy on the empty path (no changes)", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-sr-")));
    proj = dir;
    fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
    commitAll(dir);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "sr", path: dir }, { mode: "incremental" });

    // Empty path carries sel.strategy/sel.reason — not a hardcoded value.
    expect(result.selection.strategy).toBe("incremental");
    expect(result.selection.reason).toBe("no changes detected");
    expect(result.selection.files).toEqual([]);
    expect(result.total).toBe(0);
  }, 20_000);

  it("preserves the worker's fallback reason/strategy when git --changed finds no affected tests", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-sr-")));
    proj = dir;
    fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
    fs.writeFileSync(path.join(dir, "unrelated.ts"), `export const orphan = 1;\n`);
    // Worker fell back to the full suite at execution time (its own truthful label).
    const fallbackReason =
      "incremental found no affected tests (unmapped change or non-git); ran full suite";
    stageWorkerResult(dir, { strategy: "full", reason: fallbackReason, files: ["math.test.ts"] });
    // No coverage map -> the orchestrator's decision is changed-only (incremental).
    commitAll(dir);
    fs.appendFileSync(path.join(dir, "unrelated.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "sr", path: dir }, { mode: "incremental" });

    // Execution diverged from the decision: keep the worker's reason + strategy, not the
    // incremental decision reason.
    expect(result.selection.strategy).toBe("full");
    expect(result.selection.reason).toBe(fallbackReason);
    expect(result.selection.files).toEqual(["math.test.ts"]);
  }, 20_000);

  it("committed changed-only plan reports 'incremental', not 'full' (runPlan regression)", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-sr-")));
    proj = dir;
    fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
    // No coverage map → a source change resolves to changed-only (incremental, empty files).
    stageWorkerResult(dir, {
      strategy: "incremental",
      reason: "git delta via vitest --changed (static import graph)",
      files: ["math.test.ts"],
    });
    commitAll(dir);
    fs.appendFileSync(path.join(dir, "math.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const project = { projectId: "sr", path: dir };
    const plan = orch.plan(project, { mode: "incremental" });
    const result = await orch.runPlan(project, plan.planId);

    // Regression: a committed changed-only plan runs a bounded set and must NOT be "full".
    expect(result.selection.strategy).toBe("incremental");
    expect(result.selection.files).toEqual(["math.test.ts"]);
  }, 20_000);

  it("committed empty plan (no changes) reports 'incremental', not 'full' (runPlan regression)", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-sr-")));
    proj = dir;
    fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
    commitAll(dir);

    const orch = new Orchestrator({ workerPath });
    const project = { projectId: "sr", path: dir };
    const plan = orch.plan(project, { mode: "incremental" }); // no changes → empty plan
    const result = await orch.runPlan(project, plan.planId);

    expect(result.selection.strategy).toBe("incremental");
    expect(result.selection.files).toEqual([]);
    expect(result.total).toBe(0);
  }, 20_000);
});
