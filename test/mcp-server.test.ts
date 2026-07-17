import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, createMcpRequestListener } from "../src/mcp/server.ts";

async function connectClient() {
  const server = createMcpServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("createMcpServer", () => {
  it("advertises all Phase-1 tools", async () => {
    const { client, server } = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
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
    await server.close();
  });

  it("returns an UnknownProject envelope for an unregistered projectId", async () => {
    const { client, server } = await connectClient();
    const res = (await client.callTool({
      name: "run_tests",
      arguments: { projectId: "does-not-exist" },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0].text) as { code: string; message: string };
    expect(env.code).toBe("UnknownProject");
    await client.close();
    await server.close();
  });

  it("rejects a tool call with invalid params before running (schema validation)", async () => {
    const { client, server } = await connectClient();
    await expect(
      client.callTool({ name: "run_tests", arguments: {} }),
    ).rejects.toThrow();
    await client.close();
    await server.close();
  });

  it("returns NotImplemented when registry unavailable", async () => {
    const { client, server } = await connectClient();
    const res = (await client.callTool({
      name: "register_project",
      arguments: { path: "/tmp/example" },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0].text) as { code: string };
    expect(env.code).toBe("NotImplemented");
    await client.close();
    await server.close();
  });

  it("returns empty projects list when registry unavailable", async () => {
    const { client, server } = await connectClient();
    const res = (await client.callTool({
      name: "list_projects",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text) as { projects: [] };
    expect(payload.projects).toEqual([]);
    await client.close();
    await server.close();
  });

  it("run_tests's tool description documents the async job-handle contract (Story 8.6 regression guard)", async () => {
    const { client, server } = await connectClient();
    const { tools } = await client.listTools();
    const runTests = tools.find((t) => t.name === "run_tests");
    expect(runTests?.description).toMatch(/poll get_test_status/i);
    await client.close();
    await server.close();
  });
});

describe("createMcpRequestListener keep-alive ping", () => {
  it("periodically pings an open session's SSE stream, so it never sits idle", async () => {
    const httpServer = http.createServer(
      createMcpRequestListener({ token: "test-token", pingIntervalMs: 20 }),
    );
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const port = address && typeof address === "object" && address ? address.port : 0;

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: "Bearer test-token" } } },
    );
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();

    try {
      // Manual handshake (raw transport, not Client) so `ping` requests -- which the SDK's
      // Client/Server base Protocol answers automatically and never surfaces -- are observable.
      await transport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "keepalive-test", version: "0.0.0" },
        },
      } as unknown as JSONRPCMessage);
      // Sending `notifications/initialized` is what opens the standalone GET/SSE stream (SDK).
      await transport.send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      } as unknown as JSONRPCMessage);

      // Comfortably more than a few 20ms ping ticks.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const pings = received.filter(
        (m) => "method" in m && (m as { method: string }).method === "ping",
      );
      expect(pings.length).toBeGreaterThan(0);
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    }
  });
});
