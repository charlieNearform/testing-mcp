import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";
import { loadCoverageMap, coverageMapPath } from "../src/coverage/index.ts";

// Story 3.7: a full-suite coverage run is a single native Vitest pass (the equivalent of
// `vitest run --coverage`), not one process per test file, and never builds/refreshes the
// reverse coverage map.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const repoNodeModules = path.join(repoRoot, "node_modules");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

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

describe("native full-suite coverage pass (Story 3.7)", () => {
  it("reports sane whole-project percentages from one native pass and never writes a coverage-map file", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    const result = await orch.runTests({ projectId: "native1", path: proj }, { coverage: true });

    expect(result.coverage).toBeDefined();
    expect(result.coverage!.combined).toBeUndefined();
    expect(result.coverage!.confidence?.level).toBe("high");
    expect(result.coverage!.total.lines).toBeGreaterThan(0);
    expect(result.coverage!.total.lines).toBeLessThanOrEqual(100);
    expect(result.coverage!.files.some((f) => f.file.includes("math.ts"))).toBe(true);
    expect(result.coverage!.files.some((f) => f.file.includes("other.ts"))).toBe(true);
    expect(result.coverage!.files.every((f) => f.fresh === true)).toBe(true);
    expect(result.coverage!.files.every((f) => f.stale === undefined)).toBe(true);

    expect(loadCoverageMap(proj)).toBeNull();
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

  it("a changed-only run (no map yet) with coverage explicitly forced to true also takes the native pass, not per-file discovery", async () => {
    proj = makeProject();
    execFileSync("git", ["init", "-q"], { cwd: proj });
    execFileSync("git", ["add", "-A"], { cwd: proj });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: proj, env: GIT_ENV });
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests(
      { projectId: "native3", path: proj },
      { mode: "incremental", coverage: true },
    );

    // No map exists yet -> the changed-only fallback strategy (files: [], resolved via Vitest's
    // own static --changed graph), which the worker treats identically to a true full-suite run
    // for coverage purposes (Story 3.7 Dev Notes) -- native pass, no map ever written.
    expect(result.selection.strategy).toBe("incremental");
    expect(result.coverage).toBeDefined();
    expect(result.coverage!.combined).toBeUndefined();
    expect(loadCoverageMap(proj)).toBeNull();
  }, 120_000);

  it("leaves an already-existing coverage map file byte-for-byte unchanged after a full-suite coverage run", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    // Seed a real map via an explicit-files run (the only path that builds one -- Story 3.7).
    await orch.runTests(
      { projectId: "native4", path: proj },
      { coverage: true, files: ["math.test.ts", "other.test.ts"] },
    );
    const before = fs.readFileSync(coverageMapPath(proj), "utf8");

    const result = await orch.runTests({ projectId: "native4", path: proj }, { coverage: true });
    expect(result.coverage).toBeDefined();

    const after = fs.readFileSync(coverageMapPath(proj), "utf8");
    expect(after).toBe(before);
  }, 120_000);
});
