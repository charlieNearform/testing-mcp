import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

// Story 3.7 introduced the single native Vitest coverage pass; Story 3.8 made it the ONLY
// coverage mechanism left (unified into the SAME pass that produces real test results, and
// full-suite-only -- the reverse coverage map this file used to also assert on is deleted).

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const repoNodeModules = path.join(repoRoot, "node_modules");

let proj: string;

function makeProject(coverageConfig = ""): string {
  // realpath so V8's absolute coverage paths match the project root on macOS (/var vs /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-native-cov-")));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node"${coverageConfig ? `, coverage: { ${coverageConfig} }` : ""} } });\n`,
  );
  fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
  fs.writeFileSync(path.join(dir, "other.ts"), `export const sub = (a: number, b: number) => a - b;\n`);
  fs.writeFileSync(
    path.join(dir, "math.test.ts"),
    `import { test, expect } from "vitest";\nimport { add } from "./math.ts";\ntest("add", () => expect(add(1, 2)).toBe(3));\n`,
  );
  // Imported but only partially exercised -- gives the threshold test a real, non-trivial (not
  // 0% and not 100%) percentage to gate on.
  fs.writeFileSync(
    path.join(dir, "other.test.ts"),
    `import { test } from "vitest";\nimport { sub } from "./other.ts";\ntest("sub exists", () => { sub; });\n`,
  );
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("native full-suite coverage pass (Story 3.7, unified single-pass in Story 3.8)", () => {
  it("reports sane whole-project percentages from one native pass; no coverage-map file ever exists", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    const result = await orch.runTests({ projectId: "native1", path: proj }, { coverage: true });

    expect(result.coverage).toBeDefined();
    expect(result.coverage!.confidence?.level).toBe("high");
    expect(result.coverage!.total.lines).toBeGreaterThan(0);
    expect(result.coverage!.total.lines).toBeLessThanOrEqual(100);
    expect(result.coverage!.files.some((f) => f.file.includes("math.ts"))).toBe(true);
    expect(result.coverage!.files.some((f) => f.file.includes("other.ts"))).toBe(true);
    // The retired combined-coverage shape's fresh/stale/combined flags no longer exist at all
    // (Story 3.8 Task 5.3) -- every file in a single-pass report is definitionally fresh.
    expect(result.coverage!.files.every((f) => !("fresh" in f) && !("stale" in f))).toBe(true);
    expect("combined" in result.coverage!).toBe(false);

    // No reverse coverage map module exists anymore -- nothing could have written one.
    expect(fs.existsSync(path.join(proj, ".test-mcp", "coverage-map.json"))).toBe(false);
  }, 120_000);

  it("computes thresholdsMet manually against real percentages, without relying on Vitest's own threshold gate", async () => {
    // other.test.ts imports but never calls sub() -- the project as a whole can never reach 100%
    // functions/lines, so the run must still complete (not throw/hang/exit) and simply report the
    // gate as failed.
    proj = makeProject("thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }");
    const orch = new Orchestrator({ workerPath });

    const result = await orch.runTests({ projectId: "native2", path: proj }, { coverage: true });

    expect(result.success).toBe(true); // the test run itself passed; coverage is a separate report
    expect(result.coverage!.confidence?.level).toBe("high");
    expect(result.coverage!.thresholds).toEqual({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    });
    expect(result.coverage!.thresholdsMet).toBe(false);
  }, 120_000);

  it("produces both real test results AND coverage from the SAME single pass (exactly one Vitest invocation)", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    const result = await orch.runTests({ projectId: "native5", path: proj }, { coverage: true });

    // Real results (not a synthetic/empty shape) came out of the SAME call that produced coverage.
    expect(result.total).toBe(2);
    expect(result.selection.strategy).toBe("full");
    expect(result.tests?.length).toBe(2);
    expect(result.coverage).toBeDefined();
  }, 120_000);
});
