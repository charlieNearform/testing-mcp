import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDaemon, type DaemonHandle } from "../src/daemon/index.ts";

let home: string;
let handle: DaemonHandle | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-rehydrate-"));
  process.env.TEST_MCP_HOME = home;
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ schemaVersion: 1, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }),
  );
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  delete process.env.TEST_MCP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function listProjectIds(h: DaemonHandle): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${h.token}` } },
  });
  const client = new Client({ name: "rehydrate-test", version: "0.0.0" });
  await client.connect(transport);
  const res = (await client.callTool({ name: "list_projects", arguments: {} })) as {
    content: Array<{ text: string }>;
  };
  await client.close();
  const { projects } = JSON.parse(res.content[0].text) as { projects: Array<{ projectId: string }> };
  return projects.map((p) => p.projectId);
}

function healthStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: "/", headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("daemon registry rehydration", () => {
  it("rehydrates registered projects from registry.json on start", async () => {
    fs.writeFileSync(
      path.join(home, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: {
          seed123: { path: "/tmp/seeded", configPath: "/tmp/seeded/vitest.config.ts", status: "idle" },
        },
      }),
    );
    handle = await startDaemon();
    expect(await listProjectIds(handle)).toContain("seed123");
  });

  it("starts with an empty registry (no crash) when registry.json is corrupt", async () => {
    fs.writeFileSync(path.join(home, "registry.json"), "{ not json");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    handle = await startDaemon();
    expect(stderrSpy.mock.calls.some((call) => String(call[0]).includes("could not load registry"))).toBe(
      true,
    );
    stderrSpy.mockRestore();
    expect(await healthStatus(handle.port)).toBe(200);
    expect(await listProjectIds(handle)).toHaveLength(0);
  });
});
