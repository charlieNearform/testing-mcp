import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

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

/** A committed git project (Vitest + coverage-v8 via node_modules symlink) with a built coverage map. */
async function makeProjectWithMap(): Promise<string> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-sel-")));
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
  // Build the coverage map, THEN commit — so later edits show as changes vs HEAD. Explicit
  // files: a full-suite run never builds the map (Story 3.7).
  const orch = new Orchestrator({ workerPath });
  await orch.runTests(
    { projectId: "sel1", path: dir },
    { coverage: true, files: ["math.test.ts", "other.test.ts"] },
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("smart re-run decision (union + fallback)", () => {
  it("selects only the mapped test when a known source changes", async () => {
    proj = await makeProjectWithMap();
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "sel1", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(1);
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);
    expect(result.selection.files.some((f) => f.includes("other.test.ts"))).toBe(false);
  }, 120_000);

  it("does not re-select an already-validated file's tests on a later run in the same uncommitted session", async () => {
    proj = await makeProjectWithMap();
    const orch = new Orchestrator({ workerPath });
    // Rehydrate the test-file inventory that makeProjectWithMap()'s OWN (separate) Orchestrator
    // instance already persisted to disk (mirrors real daemon-startup behavior). Without this, a
    // fresh Orchestrator's inventory starts at 0 and only grows as ITS OWN runs reconcile files --
    // by the second run below, the denominator would undercount to 1 (only math.test.ts, from the
    // first run) instead of the project's real total of 2, making the Selection Engine's size-based
    // full-run escalation incorrectly kick in and run everything instead of just other.test.ts.
    orch.loadTestInventory("sel1", proj);

    // Edit math.ts and run — this run validates math.ts and advances the last-run snapshot past it.
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);
    const first = await orch.runTests({ projectId: "sel1", path: proj }, { mode: "incremental" });
    expect(first.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);

    // Edit other.ts too, still without committing math.ts's change. A second incremental run
    // must select only other.test.ts — math.ts was already validated by the prior run, so
    // `since: "last-run"` (the default) must not resurface it via the HEAD-scoped static-graph
    // union just because it's still uncommitted.
    fs.appendFileSync(path.join(proj, "other.ts"), `// touched\n`);
    const second = await orch.runTests({ projectId: "sel1", path: proj }, { mode: "incremental" });
    expect(second.selection.files.some((f) => f.includes("other.test.ts"))).toBe(true);
    expect(second.selection.files.some((f) => f.includes("math.test.ts"))).toBe(false);
  }, 120_000);

  it("runs the full suite when a changed source is unknown to the map (AC3)", async () => {
    proj = await makeProjectWithMap();
    // A brand-new source file no test imports and the map never saw.
    fs.writeFileSync(path.join(proj, "mystery.ts"), `export const x = 1;\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "sel1", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
  }, 120_000);

  it("runs only the changed test file when only a test changed (AC1)", async () => {
    proj = await makeProjectWithMap();
    fs.appendFileSync(path.join(proj, "other.test.ts"), `\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "sel1", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(1);
    expect(result.selection.files.some((f) => f.includes("other.test.ts"))).toBe(true);
  }, 120_000);
});

/** A committed git project where ONE shared source is imported by every test file, so editing it
 *  maps to (almost) the whole suite -- built to exercise the size-based escalation end-to-end
 *  through the real Orchestrator -> resolveSelection -> SelectionEngine.plan wiring, not just a
 *  hand-fed unit test of plan() itself. */
async function makeProjectWithSharedSource(fileCount: number): Promise<string> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-sel-size-")));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node" } });\n`,
  );
  fs.writeFileSync(path.join(dir, "shared.ts"), `export const val = () => 1;\n`);
  const testFiles: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    const name = `f${i}.test.ts`;
    testFiles.push(name);
    fs.writeFileSync(
      path.join(dir, name),
      `import { test, expect } from "vitest";\nimport { val } from "./shared.ts";\ntest("f${i}", () => expect(val()).toBe(1));\n`,
    );
  }
  const orch = new Orchestrator({ workerPath });
  await orch.runTests({ projectId: "sel-size", path: dir }, { coverage: true, files: testFiles });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return dir;
}

describe("smart re-run decision: size-based full-run escalation (real Orchestrator wiring)", () => {
  it("escalates to a full run when a shared source's incremental selection covers the whole suite", async () => {
    proj = await makeProjectWithSharedSource(5);
    fs.appendFileSync(path.join(proj, "shared.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    orch.loadTestInventory("sel-size", proj); // rehydrate the other Orchestrator instance's inventory
    const result = await orch.runTests({ projectId: "sel-size", path: proj }, { mode: "incremental" });

    // 5/5 selected -> 100%, over the 70% default -> the REAL wiring (not a hand-fed plan() call)
    // escalates to full, running every file.
    expect(result.selection.strategy).toBe("full");
    expect(result.selection.reason).toContain("100%");
    expect(result.total).toBe(5);
  }, 120_000);

  it("stays incremental through the real wiring when a source change's selection is comfortably under threshold", async () => {
    // 10 files: f0..f8 import other.ts (never touched here), only f9 imports lonely.ts -- editing
    // lonely.ts (a SOURCE, so this exercises the size check itself, not the "only test files
    // changed" bypass) selects exactly 1/10 (10%), nowhere near the 70% default.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-sel-size-small-")));
    proj = dir;
    fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
    fs.writeFileSync(
      path.join(dir, "vitest.config.ts"),
      `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node" } });\n`,
    );
    fs.writeFileSync(path.join(dir, "other.ts"), `export const val = () => 1;\n`);
    fs.writeFileSync(path.join(dir, "lonely.ts"), `export const val = () => 2;\n`);
    const testFiles: string[] = [];
    for (let i = 0; i < 9; i++) {
      testFiles.push(`f${i}.test.ts`);
      fs.writeFileSync(
        path.join(dir, `f${i}.test.ts`),
        `import { test, expect } from "vitest";\nimport { val } from "./other.ts";\ntest("f${i}", () => expect(val()).toBe(1));\n`,
      );
    }
    testFiles.push("f9.test.ts");
    fs.writeFileSync(
      path.join(dir, "f9.test.ts"),
      `import { test, expect } from "vitest";\nimport { val } from "./lonely.ts";\ntest("f9", () => expect(val()).toBe(2));\n`,
    );
    const seedOrch = new Orchestrator({ workerPath });
    await seedOrch.runTests({ projectId: "sel-size-small", path: dir }, { coverage: true, files: testFiles });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });

    fs.appendFileSync(path.join(dir, "lonely.ts"), `// touched\n`);
    const orch = new Orchestrator({ workerPath });
    orch.loadTestInventory("sel-size-small", dir);
    const result = await orch.runTests({ projectId: "sel-size-small", path: dir }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(1);
    expect(result.selection.files.some((f) => f.includes("f9.test.ts"))).toBe(true);
  }, 120_000);
});
