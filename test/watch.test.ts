import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";
import { WatchManager } from "../src/watch/index.ts";

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
let manager: WatchManager | undefined;

async function makeProjectWithMap(): Promise<string> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-watch-")));
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
  await new Orchestrator({ workerPath }).runTests({ projectId: "w1", path: dir }, { coverage: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return dir;
}

function poll(cond: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("poll timed out"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

afterEach(() => {
  manager?.stopAll();
  manager = undefined;
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("WatchManager", () => {
  it("re-runs affected tests when a source file changes, cached for polling", async () => {
    proj = await makeProjectWithMap();
    const orch = new Orchestrator({ workerPath });
    manager = new WatchManager(orch);

    manager.start({ projectId: "w1", path: proj }, { fastMode: true });
    expect(manager.status("w1").watching).toBe(true);

    // Change a source the map attributes to math.test.ts.
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    await poll(() => manager!.status("w1").runsCompleted >= 1, 60_000);
    const st = manager.status("w1");
    expect(st.state).toBe("complete");
    expect(st.lastResult?.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);
    expect(st.lastResult?.selection.files.some((f) => f.includes("other.test.ts"))).toBe(false);
  }, 90_000);

  it("reports not-watching status and stop() is a no-op for unknown projects", () => {
    const orch = new Orchestrator({ workerPath });
    manager = new WatchManager(orch);
    expect(manager.status("nope")).toMatchObject({ watching: false, state: "idle" });
    expect(manager.stop("nope")).toBe(false);
  });
});
