import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCHEMA_VERSION } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(repoRoot, "bin", "test-mcp.mjs");

async function poll(predicate: () => boolean, tries = 50, intervalMs = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile("node", [binPath, ...args], { cwd: repoRoot, env }, (error, stdout) => {
      resolve({ stdout: stdout ?? "", code: error ? ((error as any).code ?? 1) : 0 });
    });
  });
}

describe("cli-daemon", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let startChild: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cli-"));
    // port 0 => OS assigns a free port, so this never clashes with a real daemon on 7420.
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 })
    );
    env = { ...process.env, TEST_MCP_HOME: home };
  });

  afterAll(() => {
    if (startChild && startChild.pid && !startChild.killed) {
      try {
        startChild.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("starts the daemon and writes a lockfile", async () => {
    startChild = spawn("node", [binPath, "start"], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    startChild.stderr?.on("data", (d) => (childStderr += d.toString()));
    startChild.unref();

    const lockPath = path.join(home, "daemon.lock");
    const found = await poll(() => fs.existsSync(lockPath));
    expect(found, `lockfile never appeared; child stderr:\n${childStderr}`).toBe(true);

    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(lock.pid).toBeGreaterThan(0);
    expect(lock.port).toBeGreaterThan(0);
    expect(typeof lock.token).toBe("string");
    expect(lock.token.length).toBeGreaterThan(0);
  });

  it("reports running status", async () => {
    const { stdout, code } = await runCli(["status"], env);
    expect(code).toBe(0);
    expect(stdout).toContain("running");
    const lock = JSON.parse(fs.readFileSync(path.join(home, "daemon.lock"), "utf8"));
    expect(stdout).toContain(String(lock.pid));
  });

  it("stops the daemon and removes the lockfile", async () => {
    const { stdout, code } = await runCli(["stop"], env);
    expect(code).toBe(0);
    expect(stdout).toContain("stopped");

    const removed = await poll(() => !fs.existsSync(path.join(home, "daemon.lock")));
    expect(removed).toBe(true);
  });
});
