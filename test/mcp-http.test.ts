import { afterEach, beforeEach, describe, it, expect } from "vitest";
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-mcp-"));
  process.env.TEST_MCP_HOME = home;
  // port 0 -> OS picks a free port (never clashes with a real daemon on 7420).
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

// Minimal raw request helper so we can set Host/Origin/Authorization freely.
function rawRequest(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "POST",
        path: opts.path ?? "/mcp",
        headers: opts.headers ?? {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "raw", version: "0.0.0" },
  },
});

describe("secured MCP HTTP transport", () => {
  it("rejects a bad Host with 403 (before auth)", async () => {
    handle = await startDaemon();
    const res = await rawRequest(handle.port, {
      headers: {
        host: "evil.example.com",
        "content-type": "application/json",
        authorization: `Bearer ${handle.token}`,
      },
      body: INIT_BODY,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a foreign Origin with 403", async () => {
    handle = await startDaemon();
    const res = await rawRequest(handle.port, {
      headers: {
        host: `127.0.0.1:${handle.port}`,
        origin: "http://evil.example.com",
        "content-type": "application/json",
        authorization: `Bearer ${handle.token}`,
      },
      body: INIT_BODY,
    });
    expect(res.status).toBe(403);
  });

  it("rejects /mcp without a bearer token with 401", async () => {
    handle = await startDaemon();
    const res = await rawRequest(handle.port, {
      headers: { host: `127.0.0.1:${handle.port}`, "content-type": "application/json" },
      body: INIT_BODY,
    });
    expect(res.status).toBe(401);
  });

  it("still serves the health route with 200 and no auth", async () => {
    handle = await startDaemon();
    const res = await rawRequest(handle.port, {
      method: "GET",
      path: "/",
      headers: { host: `127.0.0.1:${handle.port}` },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok", daemon: "test-mcp" });
  });

  it("serves GET /health with 200 and no auth", async () => {
    handle = await startDaemon();
    const res = await rawRequest(handle.port, {
      method: "GET",
      path: "/health",
      headers: { host: `127.0.0.1:${handle.port}` },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok", daemon: "test-mcp" });
  });

  it("returns 400 for malformed JSON without crashing the daemon", async () => {
    handle = await startDaemon();
    const res = await rawRequest(handle.port, {
      headers: {
        host: `127.0.0.1:${handle.port}`,
        "content-type": "application/json",
        authorization: `Bearer ${handle.token}`,
      },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const health = await rawRequest(handle.port, {
      method: "GET",
      path: "/",
      headers: { host: `127.0.0.1:${handle.port}` },
    });
    expect(health.status).toBe(200);
  });

  it("lists all Phase-1 tools over an authenticated Streamable HTTP session", async () => {
    handle = await startDaemon();
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${handle.token}` } } },
    );
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "get_failure_details",
        "get_test_status",
        "list_projects",
        "register_project",
        "run_tests",
        "start_watch",
        "stop_watch",
        "unregister_project",
      ].sort(),
    );
    await client.close();
  });
});
