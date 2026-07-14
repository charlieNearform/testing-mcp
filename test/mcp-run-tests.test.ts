import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { ProjectRegistry } from "../src/registry/project-registry.ts";
import { Orchestrator } from "../src/orchestrator/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const fixture = path.join(repoRoot, "test-fixtures", "sample-project");

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

describe("run_tests over MCP", () => {
  it("runs a registered project and returns results; unknown project errors", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-runreg-"));
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { projectId } = await registry.register(fixture);
    const orchestrator = new Orchestrator({ workerPath });

    const server = createMcpServer({ registry, orchestrator });
    const client = new Client({ name: "run-test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const res = await client.callTool({ name: "run_tests", arguments: { projectId } });
    const result = JSON.parse(textOf(res)) as { total: number; failed: number };
    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);

    const unknown = await client.callTool({ name: "run_tests", arguments: { projectId: "nope" } });
    expect(JSON.parse(textOf(unknown)).code).toBe("UnknownProject");

    await client.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});
