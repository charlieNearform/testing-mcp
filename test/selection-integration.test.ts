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
