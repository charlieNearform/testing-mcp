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
// Signals "started" then blocks until "release" appears -- controlled timing, no real waits.
const blockingWorkerPath = fileURLToPath(
  new URL("../test-fixtures/blocking-worker/worker.mjs", import.meta.url),
);

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

async function setup(orchestratorOpts: ConstructorParameters<typeof Orchestrator>[0] = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-async-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-async-project-"));
  fs.writeFileSync(path.join(root, "vitest.config.ts"), "export default {};\n");
  const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
  const { projectId } = await registry.register(root);
  const orchestrator = new Orchestrator({ workerPath: blockingWorkerPath, ...orchestratorOpts });

  const server = createMcpServer({ registry, orchestrator });
  const client = new Client({ name: "async-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  const stateDir = path.join(root, ".test-mcp");
  const cleanup = async (): Promise<void> => {
    await client.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { client, projectId, root, stateDir, cleanup };
}

async function waitForStarted(stateDir: string): Promise<void> {
  const startedPath = path.join(stateDir, "started");
  for (let i = 0; i < 200 && !fs.existsSync(startedPath); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(fs.existsSync(startedPath)).toBe(true);
}

describe("run_tests async job-handle contract (Story 8.6)", () => {
  it("returns the full TestResult unchanged when the run finishes inside waitMs", async () => {
    const { client, projectId, stateDir, cleanup } = await setup();
    try {
      const pending = client.callTool({ name: "run_tests", arguments: { projectId, waitMs: 2000 } });
      await waitForStarted(stateDir);
      fs.writeFileSync(path.join(stateDir, "release"), "");
      const res = await pending;
      const result = JSON.parse(textOf(res)) as { success: boolean; runId?: string; state?: string };
      expect(result.success).toBe(true);
      expect(result.state).toBeUndefined(); // a real TestResult, not a job handle
    } finally {
      await cleanup();
    }
  }, 20_000);

  it("returns a job handle when the run is still going after waitMs, and the run keeps executing", async () => {
    const { client, projectId, stateDir, cleanup } = await setup();
    try {
      const res = await client.callTool({ name: "run_tests", arguments: { projectId, waitMs: 50 } });
      const payload = JSON.parse(textOf(res)) as {
        runId?: string;
        projectId?: string;
        state?: string;
      };
      expect(payload.state).toBe("running");
      expect(payload.projectId).toBe(projectId);
      expect(payload.runId).toBeTruthy();

      // The run kept executing after the tool call returned -- release it now and poll.
      await waitForStarted(stateDir);
      fs.writeFileSync(path.join(stateDir, "release"), "");

      let statusPayload: { state?: string; runId?: string } = {};
      for (let i = 0; i < 200; i++) {
        const statusRes = await client.callTool({ name: "get_test_status", arguments: { projectId } });
        statusPayload = JSON.parse(textOf(statusRes)) as { state?: string; runId?: string };
        if (statusPayload.state === "complete") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(statusPayload.state).toBe("complete");
      expect(statusPayload.runId).toBe(payload.runId);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it("waitMs: null waits forever, exactly like today's synchronous behavior", async () => {
    const { client, projectId, stateDir, cleanup } = await setup();
    try {
      const pending = client.callTool({ name: "run_tests", arguments: { projectId, waitMs: null } });
      await waitForStarted(stateDir);
      // Release well after a short default grace period would have fired, proving no job-handle
      // fallback happened -- the call is still genuinely awaiting the real result.
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(stateDir, "release"), "");
      const res = await pending;
      const result = JSON.parse(textOf(res)) as { success: boolean; state?: string };
      expect(result.success).toBe(true);
      expect(result.state).toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 20_000);

  it("resolves the config layering order: per-call waitMs overrides the project/daemon defaults", async () => {
    // Project-level default is a job-handle-triggering 30ms; the per-call argument overrides it
    // to wait forever, proving per-call wins over whatever the project config would have said.
    const { client, projectId, root, stateDir, cleanup } = await setup();
    try {
      fs.mkdirSync(path.join(root, ".test-mcp"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".test-mcp", "config.json"),
        JSON.stringify({ schemaVersion: 1, projectId, stateDir: ".test-mcp", defaultRunWaitMs: 30 }),
      );
      const pending = client.callTool({ name: "run_tests", arguments: { projectId, waitMs: null } });
      await waitForStarted(stateDir);
      await new Promise((r) => setTimeout(r, 200)); // well past the project's 30ms default
      fs.writeFileSync(path.join(stateDir, "release"), "");
      const res = await pending;
      const result = JSON.parse(textOf(res)) as { success: boolean; state?: string };
      expect(result.success).toBe(true);
      expect(result.state).toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 20_000);

  it("falls back to the project's config default when no per-call waitMs is given", async () => {
    const { client, projectId, root, stateDir, cleanup } = await setup();
    try {
      fs.mkdirSync(path.join(root, ".test-mcp"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".test-mcp", "config.json"),
        JSON.stringify({ schemaVersion: 1, projectId, stateDir: ".test-mcp", defaultRunWaitMs: 30 }),
      );
      const res = await client.callTool({ name: "run_tests", arguments: { projectId } });
      const payload = JSON.parse(textOf(res)) as { state?: string };
      expect(payload.state).toBe("running"); // 30ms project default elapsed with nothing released

      fs.writeFileSync(path.join(stateDir, "release"), "");
    } finally {
      await cleanup();
    }
  }, 20_000);
});

describe("get_test_status live payload (Story 8.6)", () => {
  it("includes runId and a live field while a run is in flight", async () => {
    const { client, projectId, stateDir, cleanup } = await setup();
    try {
      const pending = client.callTool({ name: "run_tests", arguments: { projectId, waitMs: 30 } });
      await waitForStarted(stateDir);
      const runRes = await pending;
      const runPayload = JSON.parse(textOf(runRes)) as { runId?: string; state?: string };
      expect(runPayload.state).toBe("running");

      const statusRes = await client.callTool({ name: "get_test_status", arguments: { projectId } });
      const status = JSON.parse(textOf(statusRes)) as {
        runId?: string;
        live?: { tests: unknown[]; log: unknown[] };
      };
      expect(status.runId).toBe(runPayload.runId);
      expect(status.live).toBeDefined();
      expect(Array.isArray(status.live!.tests)).toBe(true);
      expect(Array.isArray(status.live!.log)).toBe(true);

      fs.writeFileSync(path.join(stateDir, "release"), "");
    } finally {
      await cleanup();
    }
  }, 20_000);
});
