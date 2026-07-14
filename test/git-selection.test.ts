import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.js";

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

/** Create a small project (Vitest resolvable via a node_modules symlink); optionally a git repo. */
function makeProject(withGit: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-gitsel-"));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node" } });\n`,
  );
  fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
  fs.writeFileSync(path.join(dir, "other.ts"), `export const sub = (a: number, b: number) => a - b;\n`);
  fs.writeFileSync(path.join(dir, "unrelated.ts"), `export const orphan = 1;\n`);
  fs.writeFileSync(
    path.join(dir, "math.test.ts"),
    `import { test, expect } from "vitest";\nimport { add } from "./math.ts";\ntest("add", () => expect(add(1, 2)).toBe(3));\n`,
  );
  fs.writeFileSync(
    path.join(dir, "other.test.ts"),
    `import { test, expect } from "vitest";\nimport { sub } from "./other.ts";\ntest("sub", () => expect(sub(2, 1)).toBe(1));\n`,
  );
  if (withGit) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });
  }
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("git-aware delta selection", () => {
  it("incremental runs only the test files affected by the git diff", async () => {
    proj = makeProject(true);
    // Modify a source imported by exactly one test.
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(1);
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);
    expect(result.selection.files.some((f) => f.includes("other.test.ts"))).toBe(false);
  }, 60_000);

  it("falls back to the full suite when the change maps to no test (no silent skip)", async () => {
    proj = makeProject(true);
    // Change a source that no test imports.
    fs.appendFileSync(path.join(proj, "unrelated.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
  }, 60_000);

  it("falls back to the full suite when the project is not a git repo", async () => {
    proj = makeProject(false);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
  }, 60_000);
});
