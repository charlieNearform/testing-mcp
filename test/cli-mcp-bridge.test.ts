import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = path.join(repoRoot, "bin", "test-mcp.mjs");

let home: string;
let client: Client | undefined;

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
});
