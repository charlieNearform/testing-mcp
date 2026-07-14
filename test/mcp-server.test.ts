import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";

async function connectClient() {
  const server = createMcpServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("createMcpServer", () => {
  it("advertises all six test tools", async () => {
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
});
