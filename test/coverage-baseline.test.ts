import { afterEach, describe, expect, it } from "vitest";
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-baseline-")));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  // setupFiles imports common.ts -> it is setup-induced, must NOT become a per-test edge.
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node", setupFiles: ["./setup.ts"] } });\n`,
  );
  fs.writeFileSync(path.join(dir, "common.ts"), `export const shared = () => 42;\n`);
  fs.writeFileSync(path.join(dir, "setup.ts"), `import { shared } from "./common.ts";\nshared();\n`);
  fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
  fs.writeFileSync(path.join(dir, "other.ts"), `export const sub = (a: number, b: number) => a - b;\n`);
  fs.writeFileSync(
    path.join(dir, "math.test.ts"),
    `import { test, expect } from "vitest";\nimport { add } from "./math.ts";\ntest("add", () => expect(add(1, 2)).toBe(3));\n`,
  );
  fs.writeFileSync(
    path.join(dir, "other.test.ts"),
    `import { test, expect } from "vitest";\nimport { sub } from "./other.ts";\ntest("sub", () => expect(sub(2, 1)).toBe(1));\n`,
  );
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("setup-baseline subtraction", () => {
  it("records setup-induced modules as full-suite triggers, not per-test edges", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    // Explicit files -- a full-suite run never builds the map (Story 3.7).
    await orch.runTests(
      { projectId: "base1", path: proj },
      { coverage: true, files: ["math.test.ts", "other.test.ts"] },
    );

    const map = loadCoverageMap(proj);
    expect(map).not.toBeNull();
    expect(map!.schemaVersion).toBe(3);
    expect(map!.alwaysRun).toEqual([]);
    // common.ts is reached only via setup -> full-suite trigger, NOT a per-test edge.
    expect(map!.fullSuiteTriggers).toContain("common.ts");
    expect(map!.map["common.ts"]).toBeUndefined();
    // Real per-test edges still present.
    expect(map!.map["math.ts"].tests).toEqual(["math.test.ts"]);
    expect(map!.map["other.ts"].tests).toEqual(["other.test.ts"]);
  }, 120_000);
});
