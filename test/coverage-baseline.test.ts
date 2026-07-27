import { afterEach, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

/**
 * Setup-baseline subtraction (Story 3.3) doesn't exist as a mechanism anymore -- there is no
 * reverse coverage map to subtract a baseline from (Story 3.8 retired it). This story's own
 * investigation ran a live experiment proving Vitest's own dependency graph ALREADY resolves a
 * setup file's dependents correctly with NO custom logic needed: `related: [setupFileAbs]`
 * against a 2-test-file fixture where only `vitest.config.ts`'s `setupFiles` (not a direct
 * import) connects them selected BOTH test files, not zero. This test asserts exactly that
 * through the real Orchestrator -> worker -> Vitest wiring, end to end.
 */

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

function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-baseline-")));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  // The ONLY connection from a test to `setup.ts` is Vitest's own `test.setupFiles` config,
  // never a static `import` statement in the test file itself -- matching the exact shape this
  // story's live experiment used (`related: [setupFileAbs]`, not one of the setup file's own
  // transitive imports).
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node", setupFiles: ["./setup.ts"] } });\n`,
  );
  fs.writeFileSync(path.join(dir, "setup.ts"), `export const setupRan = true;\n`);
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
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("Vitest's own `related` graph resolves setupFiles dependents (Story 3.8, no custom logic needed)", () => {
  it("a setup-file change selects every test file that uses it, not zero", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });
    // Warm the test-file inventory (size-based escalation's denominator) with a plain full run.
    await orch.runTests({ projectId: "base1", path: proj }, { coverage: false });

    fs.appendFileSync(path.join(proj, "setup.ts"), `// touched\n`);
    const result = await orch.runTests({ projectId: "base1", path: proj }, { mode: "incremental" });

    // Both test files ran -- Vitest's own dependency graph already tracks that `setup.ts`
    // (reached only via `test.setupFiles`, never a direct `import`) is a dependency of every
    // test through the setup mechanism, confirming the empty-match safety net is unnecessary
    // here (no custom "full-suite trigger" concept had to be re-derived without the map).
    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(2);
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);
    expect(result.selection.files.some((f) => f.includes("other.test.ts"))).toBe(true);
  }, 120_000);
});
