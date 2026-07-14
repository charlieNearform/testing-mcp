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

function textOf(res: unknown): { isError?: boolean; text: string } {
  const r = res as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: r.isError, text: r.content[0].text };
}

describe("get_failure_details over MCP", () => {
  it("returns full detail for a failing test, and errors on unknown ids/projects", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-faildetail-"));
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { projectId } = await registry.register(fixture);
    const orchestrator = new Orchestrator({ workerPath });

    const server = createMcpServer({ registry, orchestrator });
    const client = new Client({ name: "fail-detail", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    // Run, then pull the failing test's id from the compact result.
    const runRes = textOf(await client.callTool({ name: "run_tests", arguments: { projectId } }));
    expect(runRes.isError).toBeFalsy();
    const result = JSON.parse(runRes.text) as {
      failures: Array<{ id: string; name: string; message: string; stack?: string }>;
    };
    const failure = result.failures.find((f) => f.name.includes("intentional failure"));
    expect(failure).toBeTruthy();
    // Compact result must NOT carry stacks (progressive disclosure).
    expect(failure!.stack).toBeUndefined();

    // Full detail on demand.
    const detailRes = textOf(
      await client.callTool({
        name: "get_failure_details",
        arguments: { projectId, failureId: failure!.id },
      }),
    );
    expect(detailRes.isError).toBeFalsy();
    const detail = JSON.parse(detailRes.text) as {
      name: string;
      message: string;
      stack?: string;
      expected?: string;
      actual?: string;
    };
    expect(detail.name).toContain("intentional failure");
    expect(typeof detail.stack).toBe("string");
    expect(detail.stack!.length).toBeGreaterThan(0);
    // toBe(3) vs 2 => assertion detail present.
    expect(detail.expected).toBeDefined();
    expect(detail.actual).toBeDefined();

    // Unknown failureId => ValidationError.
    const unknownFail = textOf(
      await client.callTool({
        name: "get_failure_details",
        arguments: { projectId, failureId: "does-not-exist" },
      }),
    );
    expect(unknownFail.isError).toBe(true);
    expect(JSON.parse(unknownFail.text).code).toBe("ValidationError");

    // Unknown project => UnknownProject.
    const unknownProj = textOf(
      await client.callTool({
        name: "get_failure_details",
        arguments: { projectId: "nope", failureId: "x" },
      }),
    );
    expect(unknownProj.isError).toBe(true);
    expect(JSON.parse(unknownProj.text).code).toBe("UnknownProject");

    // A later successful all-pass run replaces the cache; prior failureIds expire.
    const passOnly = textOf(
      await client.callTool({
        name: "run_tests",
        arguments: { projectId, files: ["pass.test.ts"] },
      }),
    );
    expect(passOnly.isError).toBeFalsy();
    const expired = textOf(
      await client.callTool({
        name: "get_failure_details",
        arguments: { projectId, failureId: failure!.id },
      }),
    );
    expect(expired.isError).toBe(true);
    expect(JSON.parse(expired.text).code).toBe("ValidationError");

    await client.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});
