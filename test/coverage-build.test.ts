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

/** A tiny project whose Vitest (and @vitest/coverage-v8) resolve via a node_modules symlink.
 *  `coverageConfig` is spliced into `test.coverage` (Story 6.3 AC4 threshold-gate tests). */
function makeProject(coverageConfig = ""): string {
  // realpath so V8's absolute coverage paths match the project root on macOS (/var vs /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cov-")));
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
  fs.writeFileSync(
    path.join(dir, "other.test.ts"),
    `import { test, expect } from "vitest";\nimport { sub } from "./other.ts";\ntest("sub", () => expect(sub(2, 1)).toBe(1));\n`,
  );
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("coverage reverse-map build & persist", () => {
  it("builds and persists a correct source->test map on a full coverage run", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    const result = await orch.runTests({ projectId: "cov1", path: proj }, { coverage: true });
    expect(result.total).toBe(2);

    // Story 6.3/6.10: a coverage run carries a COMBINED overall + per-file coverage report.
    expect(result.coverage).toBeDefined();
    expect(result.coverage!.combined).toBe(true);
    expect(result.coverage!.total.lines).toBeGreaterThan(0);
    expect(result.coverage!.total.lines).toBeLessThanOrEqual(100);
    expect(result.coverage!.files.some((f) => f.file.includes("math.ts"))).toBe(true);
    // A full fresh run: every file re-measured this run -> high confidence, files marked fresh.
    expect(result.coverage!.confidence?.level).toBe("high");
    expect(result.coverage!.files.every((f) => f.fresh === true)).toBe(true);

    const map = loadCoverageMap(proj);
    expect(map).not.toBeNull();
    expect(map!.schemaVersion).toBe(3);
    expect(map!.alwaysRun).toEqual([]);
    expect(map!.projectId).toBe("cov1");
    expect(map!.map["math.ts"].tests).toEqual(["math.test.ts"]);
    expect(map!.map["other.ts"].tests).toEqual(["other.test.ts"]);
  }, 120_000);

  it("updates only the given test file incrementally, preserving other edges", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    await orch.runTests({ projectId: "cov1", path: proj }, { coverage: true });
    // Incremental re-measure of just math.test.ts.
    await orch.runTests({ projectId: "cov1", path: proj }, { coverage: true, files: ["math.test.ts"] });

    const map = loadCoverageMap(proj);
    expect(map).not.toBeNull();
    // other.ts edge preserved (not re-measured), math.ts edge still present.
    expect(map!.map["other.ts"].tests).toEqual(["other.test.ts"]);
    expect(map!.map["math.ts"].tests).toEqual(["math.test.ts"]);
  }, 120_000);

  // Story 6.10: an incremental coverage run reports the COMBINED whole-project picture (baseline
  // carried) and flags a changed-but-unmeasured source as stale + degraded.
  it("combines baseline + incremental and flags a changed unmeasured source as stale", async () => {
    proj = makeProject();
    const o = new Orchestrator({ workerPath });

    // Baseline full coverage run: whole project measured, high confidence.
    const baseline = await o.runTests({ projectId: "cov1", path: proj }, { coverage: true });
    expect(baseline.coverage!.confidence?.level).toBe("high");
    expect(baseline.coverage!.files.map((f) => f.file).sort()).toEqual(["math.ts", "other.ts"]);

    // Edit math.ts (its coverage is now stale), then re-measure ONLY other.test.ts.
    fs.appendFileSync(path.join(proj, "math.ts"), `export const mul = (a: number, b: number) => a * b;\n`);
    const incr = await o.runTests(
      { projectId: "cov1", path: proj },
      { coverage: true, files: ["other.test.ts"] },
    );

    // Combined still covers the whole project (math.ts carried from baseline)...
    expect(incr.coverage!.combined).toBe(true);
    const mathRow = incr.coverage!.files.find((f) => f.file === "math.ts");
    const otherRow = incr.coverage!.files.find((f) => f.file === "other.ts");
    expect(mathRow).toBeDefined();
    // ...but math.ts changed and was NOT re-measured -> stale + degraded; other.ts was fresh.
    expect(mathRow!.stale).toBe(true);
    expect(otherRow!.fresh).toBe(true);
    expect(incr.coverage!.confidence?.level).toBe("degraded");
    expect(incr.coverage!.confidence?.reasons.join(" ")).toContain("math.ts");
  }, 120_000);

  // Story 6.3 AC4: report the PROJECT's configured Vitest thresholds + a met/failed verdict,
  // asserted only at high confidence.
  it("reports the project's coverage thresholds and a met verdict at high confidence", async () => {
    // The fixture's two sources are each fully exercised by their tests -> 100% -> gate met.
    proj = makeProject("thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }");
    const o = new Orchestrator({ workerPath });
    const result = await o.runTests({ projectId: "cov1", path: proj }, { coverage: true });

    expect(result.coverage!.confidence?.level).toBe("high");
    expect(result.coverage!.thresholds).toEqual({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    });
    expect(result.coverage!.thresholdsMet).toBe(true);
  }, 120_000);
});

// Coverage defaults to "opt out" once a project has proven it works there (an existing coverage
// map), and stays "opt in" (off) until then — a fresh project isn't forced into an unmeasured
// attempt on every run just because coverage exists as a capability.
describe("coverage default (opt-out once a project has a coverage map)", () => {
  it("omitting `coverage` on a fresh project (no map yet) still runs without coverage", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    const result = await orch.runTests({ projectId: "cov1", path: proj }, {});

    expect(result.coverage).toBeUndefined();
    expect(loadCoverageMap(proj)).toBeNull();
  }, 120_000);

  it("omitting `coverage` after the project has a map defaults it to true", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    // Build the map with an explicit opt-in, as today.
    await orch.runTests({ projectId: "cov1", path: proj }, { coverage: true });
    expect(loadCoverageMap(proj)).not.toBeNull();

    // A later run that doesn't mention `coverage` at all now gets it by default.
    const result = await orch.runTests({ projectId: "cov1", path: proj }, { files: ["math.test.ts"] });
    expect(result.coverage).toBeDefined();
  }, 120_000);

  it("`coverage: false` still opts out even when the project already has a map", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    await orch.runTests({ projectId: "cov1", path: proj }, { coverage: true });
    expect(loadCoverageMap(proj)).not.toBeNull();

    const result = await orch.runTests(
      { projectId: "cov1", path: proj },
      { coverage: false, files: ["math.test.ts"] },
    );
    expect(result.coverage).toBeUndefined();
  }, 120_000);
});
