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

/** A tiny project whose Vitest (and @vitest/coverage-v8) resolve via a node_modules symlink. */
function makeProject(): string {
  // realpath so V8's absolute coverage paths match the project root on macOS (/var vs /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cov-")));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node" } });\n`,
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

    // Story 6.3: a coverage run also carries an overall + per-file coverage report.
    expect(result.coverage).toBeDefined();
    expect(result.coverage!.total.lines).toBeGreaterThan(0);
    expect(result.coverage!.total.lines).toBeLessThanOrEqual(100);
    expect(result.coverage!.files.some((f) => f.file.includes("math.ts"))).toBe(true);

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
});
