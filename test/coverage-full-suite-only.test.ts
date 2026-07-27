import { afterEach, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { ProjectRegistry } from "../src/registry/project-registry.ts";
import { Orchestrator, SelectionError } from "../src/orchestrator/index.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

/**
 * Story 3.8 AC2: coverage is full-suite-only. An incremental/selective request with
 * `coverage: true` must be rejected with a structured error -- never silently ignored or
 * downgraded -- and omitting `coverage` on an incremental run must never measure it, even
 * moments after a coverage-enabled full run (no lingering state carried between runs).
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const repoNodeModules = path.join(repoRoot, "node_modules");

let proj: string;

/** A committed git project -- so `mode: "incremental"` genuinely resolves to strategy
 *  "incremental" (not "full" via the "cannot determine changed files" non-git fallback). */
function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-covreject-")));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node" } });\n`,
  );
  fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
  fs.writeFileSync(
    path.join(dir, "math.test.ts"),
    `import { test, expect } from "vitest";\nimport { add } from "./math.ts";\ntest("add", () => expect(add(1, 2)).toBe(3));\n`,
  );
  // A second, unrelated test file -- so a single-source edit's related-file count stays well
  // under the size-based full-run escalation's default 70% threshold (Task 3.4), which would
  // otherwise trigger on a 1-test-file project and confound these tests with an unrelated
  // "escalated to full for size reasons" outcome.
  fs.writeFileSync(path.join(dir, "other.ts"), `export const sub = (a: number, b: number) => a - b;\n`);
  fs.writeFileSync(
    path.join(dir, "other.test.ts"),
    `import { test, expect } from "vitest";\nimport { sub } from "./other.ts";\ntest("sub", () => expect(sub(2, 1)).toBe(1));\n`,
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return dir;
}

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("coverage is full-suite-only (Story 3.8 AC2), orchestrator level", () => {
  it("throws SelectionError for an incremental (git-delta) request with coverage:true", async () => {
    proj = makeProject();
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);
    const orch = new Orchestrator({ workerPath });
    await expect(
      orch.runTests({ projectId: "cov1", path: proj }, { mode: "incremental", coverage: true }),
    ).rejects.toBeInstanceOf(SelectionError);
  });

  it("throws SelectionError for an explicit-files request with coverage:true (also not a genuine full-suite run)", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });
    await expect(
      orch.runTests({ projectId: "cov2", path: proj }, { files: ["math.test.ts"], coverage: true }),
    ).rejects.toBeInstanceOf(SelectionError);
  });

  it("never measures coverage on an incremental run even moments after a coverage-enabled full run (no lingering state)", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    const full = await orch.runTests({ projectId: "cov3", path: proj }, { coverage: true });
    expect(full.coverage).toBeDefined();

    // Immediately after, with no explicit coverage flag: incremental must default to NO coverage
    // (never inherit/carry over the prior full run's coverage-enabled state).
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);
    const incremental = await orch.runTests({ projectId: "cov3", path: proj }, { mode: "incremental" });
    expect(incremental.coverage).toBeUndefined();
  }, 60_000);

  it("a full-suite request with coverage omitted defaults to true unconditionally (AC3)", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "cov4", path: proj });
    expect(result.selection.strategy).toBe("full");
    expect(result.coverage).toBeDefined();
  }, 60_000);
});

describe("coverage is full-suite-only (Story 3.8 AC2), MCP layer maps SelectionError to ValidationError", () => {
  it("run_tests rejects an incremental coverage:true request with a ValidationError envelope naming the constraint", async () => {
    proj = makeProject();
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-covreject-registry-"));
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { projectId } = await registry.register(proj);
    const orchestrator = new Orchestrator({ workerPath });

    const server = createMcpServer({ registry, orchestrator });
    const client = new Client({ name: "cov-reject-test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const res = await client.callTool({
      name: "run_tests",
      arguments: { projectId, mode: "incremental", coverage: true },
    });
    const body = JSON.parse(textOf(res)) as { code: string; message: string };
    expect(body.code).toBe("ValidationError");
    expect(body.message).toContain("full-suite");

    await client.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 30_000);
});
