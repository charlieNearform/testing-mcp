import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";
import { loadCoverageMap } from "../src/coverage/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const repoNodeModules = path.join(repoRoot, "node_modules");

let proj: string;

function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-unmeas-")));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node", testTimeout: 20000 } });\n`,
  );
  fs.writeFileSync(path.join(dir, "fast.ts"), `export const one = () => 1;\n`);
  fs.writeFileSync(
    path.join(dir, "fast.test.ts"),
    `import { test, expect } from "vitest";\nimport { one } from "./fast.ts";\ntest("one", () => expect(one()).toBe(1));\n`,
  );
  // A slow test that outlives a tiny measurement budget (but not vitest's testTimeout).
  fs.writeFileSync(
    path.join(dir, "slow.test.ts"),
    `import { test, expect } from "vitest";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 3000)); expect(true).toBe(true); });\n`,
  );
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
  delete process.env.TEST_MCP_MEASURE_BUDGET_MS;
});

describe("unmeasurable tests -> always-run", () => {
  it("records a test exceeding the measurement budget as always-run, maps the rest", async () => {
    proj = makeProject();
    process.env.TEST_MCP_MEASURE_BUDGET_MS = "500"; // slow.test.ts (3s) will exceed this
    const orch = new Orchestrator({ workerPath });

    // Explicit files -- a full-suite run never builds the map (Story 3.7).
    await orch.runTests(
      { projectId: "unmeas1", path: proj },
      { coverage: true, files: ["fast.test.ts", "slow.test.ts"] },
    );

    const map = loadCoverageMap(proj);
    expect(map).not.toBeNull();
    expect(map!.schemaVersion).toBe(3);
    expect(map!.alwaysRun).toContain("slow.test.ts");
    expect(map!.map["fast.ts"].tests).toEqual(["fast.test.ts"]);
  }, 120_000);
});
