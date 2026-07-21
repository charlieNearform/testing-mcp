import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as net from "node:net";
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

/** A real, pinned free port -- unlike `port: 0`, which the daemon would re-randomize on every
 *  restart, this lets the restart test assert the refreshed daemon lands back on the SAME
 *  address (the actual property a bridge client's recovery depends on). */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
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

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cli-"));
    // A pinned free port (not `0`) so a restart lands the daemon back on the SAME address --
    // this never clashes with a real daemon on 7420 either way.
    const port = await getFreePort();
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, port, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 })
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
    // The restart test below replaces startChild's daemon with a new, untracked detached
    // process -- if an earlier test in this file fails/aborts before "stops the daemon" runs,
    // that replacement would otherwise leak. Kill whatever the lockfile says is current too.
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(home, "daemon.lock"), "utf8"));
      if (lock?.pid) process.kill(lock.pid, "SIGKILL");
    } catch {
      // no lockfile, or the pid is already gone -- nothing to clean up
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("restart is a no-op when the daemon isn't running", async () => {
    const { stdout, code } = await runCli(["restart"], env);
    expect(code).toBe(0);
    expect(stdout).toContain("not running");
    expect(fs.existsSync(path.join(home, "daemon.lock"))).toBe(false);
  });

  it("restart cleans up a stale lockfile (dead pid) instead of erroring, matching `stop`'s own behavior", async () => {
    const lockPath = path.join(home, "daemon.lock");
    // A pid that is certainly not alive: spawn a trivial child and wait for it to exit.
    const dead = spawn(process.execPath, ["-e", ""]);
    const deadPid: number = await new Promise((resolve) => {
      dead.once("exit", () => resolve(dead.pid!));
    });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, port: 12345, token: "stale", startedAt: new Date().toISOString() }),
    );

    const { stdout, code } = await runCli(["restart"], env);
    expect(code).toBe(0);
    expect(stdout).toContain("not running");
    expect(fs.existsSync(lockPath)).toBe(false); // stopDaemon() cleans up the stale lockfile
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

  it("restart replaces a running daemon with a fresh one on the same port -- what `pnpm build` now triggers", async () => {
    const before = JSON.parse(fs.readFileSync(path.join(home, "daemon.lock"), "utf8"));

    const { stdout, code } = await runCli(["restart"], env);
    expect(code).toBe(0);
    expect(stdout).toContain("refreshed");
    expect(stdout).toContain(String(before.pid));

    const changed = await poll(() => {
      if (!fs.existsSync(path.join(home, "daemon.lock"))) return false;
      const after = JSON.parse(fs.readFileSync(path.join(home, "daemon.lock"), "utf8"));
      return after.pid !== before.pid;
    });
    expect(changed).toBe(true);

    const after = JSON.parse(fs.readFileSync(path.join(home, "daemon.lock"), "utf8"));
    expect(after.pid).not.toBe(before.pid);
    expect(after.port).toBe(before.port); // same pinned config -> same address, no reconnect needed
    expect(after.token).toBe(before.token); // stable-across-restarts token -> the bridge's cached
    // Authorization header is still valid against the new daemon without needing a fresh handshake.
    expect(() => process.kill(before.pid, 0)).toThrow(); // the OLD process is genuinely gone
  }, 15_000);

  it("stops the daemon and removes the lockfile", async () => {
    const { stdout, code } = await runCli(["stop"], env);
    expect(code).toBe(0);
    expect(stdout).toContain("stopped");

    const removed = await poll(() => !fs.existsSync(path.join(home, "daemon.lock")));
    expect(removed).toBe(true);
  });
});
