import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { ProjectRegistry } from "../src/registry/project-registry.ts";

let tmp: string;
let projectDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-mcpreg-"));
  projectDir = path.join(tmp, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "vitest.config.ts"), "export default {};\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connect(registry: ProjectRegistry) {
  const server = createMcpServer({ registry });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, server };
}

function textOf(res: unknown): { isError?: boolean; text: string } {
  const r = res as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: r.isError, text: r.content[0].text };
}

describe("MCP registry tools", () => {
  it("register_project → list_projects → unregister_project round-trip", async () => {
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { client, server } = await connect(registry);

    const reg = textOf(await client.callTool({ name: "register_project", arguments: { path: projectDir } }));
    expect(reg.isError).toBeFalsy();
    const { projectId } = JSON.parse(reg.text) as { projectId: string };

    const list = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
    const { projects } = JSON.parse(list.text) as { projects: Array<{ projectId: string }> };
    expect(projects.map((p) => p.projectId)).toContain(projectId);

    // A registered project now takes the NotImplemented path (execution is a later epic).
    const run = textOf(await client.callTool({ name: "run_tests", arguments: { projectId } }));
    expect(run.isError).toBe(true);
    expect(JSON.parse(run.text).code).toBe("NotImplemented");

    const unreg = textOf(await client.callTool({ name: "unregister_project", arguments: { projectId } }));
    expect(JSON.parse(unreg.text)).toEqual({ projectId, removed: true });

    await client.close();
    await server.close();
  });

  it("register_project on a config-less path returns InvalidConfig", async () => {
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { client, server } = await connect(registry);
    const noConfig = path.join(tmp, "empty");
    fs.mkdirSync(noConfig);
    const res = textOf(await client.callTool({ name: "register_project", arguments: { path: noConfig } }));
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text).code).toBe("InvalidConfig");
    await client.close();
    await server.close();
  });

  it("unregister of an unknown projectId returns UnknownProject", async () => {
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { client, server } = await connect(registry);
    const res = textOf(await client.callTool({ name: "unregister_project", arguments: { projectId: "nope" } }));
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text).code).toBe("UnknownProject");
    await client.close();
    await server.close();
  });

  it("unregister with purge:true removes the project's .test-mcp directory", async () => {
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const stateDir = path.join(projectDir, ".test-mcp");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "config.json"), '{"projectId":"x"}\n');
    const { projectId } = await registry.register(projectDir);
    const { client, server } = await connect(registry);

    const unreg = textOf(
      await client.callTool({ name: "unregister_project", arguments: { projectId, purge: true } }),
    );
    expect(JSON.parse(unreg.text)).toEqual({ projectId, removed: true });
    expect(fs.existsSync(stateDir)).toBe(false);

    await client.close();
    await server.close();
  });
});
