import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = path.join(repoRoot, "bin", "test-mcp.mjs");

let home: string;
let client: Client | undefined;

/**
 * Grab a free, OS-assigned port and release it immediately. Plain `port: 0` (used elsewhere in
 * this suite) gives no reuse guarantee across daemon restarts; pinning this literal value in
 * config.json lets a stopped-then-restarted daemon land back on the SAME address.
 */
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

/**
 * `test-mcp start` stays attached to the foreground (that process IS the daemon), so it can't be
 * awaited via execFile the way `stop`/`status` can -- detach it and poll the lockfile instead,
 * mirroring `ensureDaemon`'s own boot-and-poll loop in src/cli/main.ts.
 */
async function pollLockfileAlive(
  homeDir: string,
  tries = 100,
  intervalMs = 100,
): Promise<{ pid: number; port: number }> {
  const lockPath = path.join(homeDir, "daemon.lock");
  for (let i = 0; i < tries; i++) {
    if (fs.existsSync(lockPath)) {
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number; port: number };
        process.kill(lock.pid, 0); // throws if the pid isn't alive
        return lock;
      } catch {
        // lockfile mid-write or pid not yet alive -- keep polling
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`daemon did not become ready in ${homeDir} within ${tries * intervalMs}ms`);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-bridge-"));
  // port 0 => OS picks a free port for the auto-booted daemon.
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ schemaVersion: 1, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }),
  );
});

afterEach(async () => {
  if (client) {
    await client.close();
    client = undefined;
  }
  // Best-effort daemon stop so no server leaks between tests.
  try {
    await execFileAsync(process.execPath, [bin, "stop"], {
      cwd: home,
      env: { ...process.env, TEST_MCP_HOME: home },
    });
  } catch {
    // ignore
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("test-mcp mcp-bridge (CLI)", () => {
  it("--no-spawn fails when the daemon is not running", async () => {
    await expect(
      execFileAsync(process.execPath, [bin, "mcp-bridge", "--no-spawn"], {
        cwd: home,
        env: { ...process.env, TEST_MCP_HOME: home },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("DaemonUnavailable"),
    });
  });

  it("proxies a real MCP session from stdio to the HTTP daemon, auto-booting it", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "mcp-bridge"],
      env: { ...process.env, TEST_MCP_HOME: home } as Record<string, string>,
    });
    client = new Client({ name: "bridge-e2e", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toContain("register_project");

    // Round-trip an actual tool call through the bridge to prove auth + forwarding both work,
    // not just the initialize handshake.
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-bridge-proj-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: project });
      fs.writeFileSync(path.join(project, "vitest.config.ts"), "export default {};\n");
      const res = (await client.callTool({
        name: "register_project",
        arguments: { path: project },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      const payload = JSON.parse(res.content[0].text) as { projectId?: string };
      expect(res.isError).toBeFalsy();
      expect(payload.projectId).toBeTruthy();
      // The daemon really did boot and persist this registration.
      const reg = JSON.parse(fs.readFileSync(path.join(home, "registry.json"), "utf8"));
      expect(Object.keys(reg.projects)).toContain(payload.projectId);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("recovers a tool call after the daemon is restarted mid-session, without the client seeing an error", async () => {
    // Pin a deterministic port so the restarted daemon below binds to the SAME address the
    // already-running bridge is pointed at (see getFreePort's doc comment).
    const port = await getFreePort();
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ schemaVersion: 1, port, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "mcp-bridge"],
      env: { ...process.env, TEST_MCP_HOME: home } as Record<string, string>,
    });
    client = new Client({ name: "bridge-recover-e2e", version: "0.0.0" });
    await client.connect(transport);

    const project = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-bridge-recover-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: project });
      fs.writeFileSync(path.join(project, "vitest.config.ts"), "export default {};\n");

      // First call succeeds normally and establishes a real daemon-side session.
      const first = (await client.callTool({
        name: "register_project",
        arguments: { path: project },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(first.isError).toBeFalsy();

      // Stop the daemon (clean SIGTERM shutdown) and start a fresh one on the SAME pinned port:
      // its in-memory session map is genuinely empty, mirroring a real daemon restart, while the
      // bridge process (and its stdio MCP client) keeps running untouched throughout.
      await execFileAsync(process.execPath, [bin, "stop"], {
        cwd: home,
        env: { ...process.env, TEST_MCP_HOME: home },
      });
      const restarted = spawn(process.execPath, [bin, "start"], {
        cwd: home,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, TEST_MCP_HOME: home },
      });
      restarted.unref();
      await pollLockfileAlive(home);

      // The SAME already-connected bridge/client issues another call. The daemon 404s the
      // bridge's now-dead session id; the bridge must transparently recreate the session, replay
      // the cached handshake, and retry -- so this succeeds instead of erroring or hanging.
      const second = (await client.callTool({
        name: "register_project",
        arguments: { path: project },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(second.isError).toBeFalsy();
      const payload = JSON.parse(second.content[0].text) as { projectId?: string };
      expect(payload.projectId).toBeTruthy();
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);
});
