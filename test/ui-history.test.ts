import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleUiRequest } from "../src/ui/index.ts";
import type { Orchestrator, RunRecord } from "../src/orchestrator/index.ts";

function fakeReq(url: string): IncomingMessage {
  return { method: "GET", url, headers: {}, on: () => undefined } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { statusCode: number; body: string } {
  const res = { statusCode: 0, body: "" } as ServerResponse & { statusCode: number; body: string };
  res.writeHead = ((status: number) => {
    res.statusCode = status;
    return res;
  }) as ServerResponse["writeHead"];
  res.end = ((chunk?: unknown) => {
    res.body = typeof chunk === "string" ? chunk : "";
    return res;
  }) as ServerResponse["end"];
  return res;
}

const rec: RunRecord = {
  runId: "run-1",
  projectId: "proj-1",
  startedAt: "2026-07-15T10:00:00.000Z",
  finishedAt: "2026-07-15T10:00:01.000Z",
  durationMs: 1000,
  status: "complete",
  result: {
    success: true,
    summary: "2 passed",
    duration: 900,
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    failures: [],
    selection: { strategy: "incremental", reason: "coverage-map selection", files: ["test/math.test.js"] },
  },
  failures: [],
};

const orchestrator = {
  getRunStatus: () => ({ state: "idle" as const }),
  getRunHistory: (pid: string) => (pid === "proj-1" ? [rec] : []),
  getRun: (pid: string, id: string) => (pid === "proj-1" && id === "run-1" ? rec : undefined),
  onStatusChange: () => () => undefined,
} as unknown as Orchestrator;

describe("UI run-history endpoints", () => {
  it("lists run summaries for a project", async () => {
    const res = fakeRes();
    const handled = await handleUiRequest(fakeReq("/ui/api/projects/proj-1/runs"), res, { orchestrator });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { projectId: string; runs: Array<Record<string, unknown>> };
    expect(body.projectId).toBe("proj-1");
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ runId: "run-1", status: "complete", strategy: "incremental", total: 2 });
  });

  it("returns full run detail (with selection files) by id", async () => {
    const res = fakeRes();
    await handleUiRequest(fakeReq("/ui/api/projects/proj-1/runs/run-1"), res, { orchestrator });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as RunRecord;
    expect(body.runId).toBe("run-1");
    expect(body.result?.selection.files).toEqual(["test/math.test.js"]);
  });

  it("404s an unknown run id", async () => {
    const res = fakeRes();
    await handleUiRequest(fakeReq("/ui/api/projects/proj-1/runs/nope"), res, { orchestrator });
    expect(res.statusCode).toBe(404);
  });
});
