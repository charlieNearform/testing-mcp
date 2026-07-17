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
// Signals "started" then blocks until "release" appears (see test-fixtures/blocking-worker) --
// it never sends a real "progress" IPC message, which is exactly what isolates the keep-alive
// interval's own re-sends from any orchestrator-driven progress event.
const blockingWorkerPath = fileURLToPath(
  new URL("../test-fixtures/blocking-worker/worker.mjs", import.meta.url),
);

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

  it("re-sends progress on a fixed cadence to keep a long run's SSE stream alive, even with no real progress event", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-keepalive-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-keepalive-project-"));
    fs.writeFileSync(path.join(root, "vitest.config.ts"), "export default {};\n");
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { projectId } = await registry.register(root);
    const orchestrator = new Orchestrator({ workerPath: blockingWorkerPath });

    const server = createMcpServer({ registry, orchestrator, progressKeepAliveMs: 20 });
    const client = new Client({ name: "keepalive-test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const progressUpdates: Array<{ progress: number; total?: number }> = [];
    const pending = client.callTool(
      { name: "run_tests", arguments: { projectId } },
      undefined,
      { onprogress: (p) => progressUpdates.push(p) },
    );

    const startedPath = path.join(root, ".test-mcp", "started");
    for (let i = 0; i < 200 && !fs.existsSync(startedPath); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fs.existsSync(startedPath)).toBe(true);

    // The fixture never emits a real "progress" IPC message -- any updates seen here can only be
    // the handler's own keep-alive re-sends of the last known (still 0/0) progress.
    await new Promise((r) => setTimeout(r, 150));
    expect(progressUpdates.length).toBeGreaterThan(0);

    fs.writeFileSync(path.join(root, ".test-mcp", "release"), "");
    const res = await pending;
    const result = JSON.parse(textOf(res)) as { success: boolean };
    expect(result.success).toBe(true);

    await client.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }, 20_000);
});
