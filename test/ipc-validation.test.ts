import { describe, it, expect } from "vitest";
import { parseToWorker, parseFromWorker } from "../src/types/ipc.ts";

const validResult = {
  success: true,
  summary: "1 passed",
  duration: 5,
  total: 1,
  passed: 1,
  failed: 0,
  skipped: 0,
  failures: [],
  selection: { strategy: "full", reason: "full suite", files: [] },
};

describe("IPC message validation at the process boundary", () => {
  it("accepts a well-formed run message", () => {
    const msg = {
      type: "run",
      runId: "r1",
      projectId: "p1",
      files: ["a.test.ts"],
      coverage: false,
      allTestsRun: false,
      changed: true,
    };
    expect(parseToWorker(msg)).toEqual(msg);
  });

  it("rejects a run message missing required fields", () => {
    expect(() => parseToWorker({ type: "run", runId: "r1" })).toThrow();
  });

  it("rejects an unknown message type", () => {
    expect(() => parseToWorker({ type: "explode" })).toThrow();
    expect(() => parseFromWorker({ type: "explode" })).toThrow();
  });

  it("accepts a well-formed result message and passes the result through", () => {
    const msg = { type: "result", runId: "r1", result: validResult };
    expect(parseFromWorker(msg)).toMatchObject({ type: "result", runId: "r1" });
  });

  it("rejects a result message whose result is not an object", () => {
    expect(() => parseFromWorker({ type: "result", runId: "r1", result: 42 })).toThrow();
  });

  it("rejects a result message missing runId", () => {
    expect(() => parseFromWorker({ type: "result", result: validResult })).toThrow();
  });

  it("passes a well-formed tests list through (Story 6.1)", () => {
    const result = {
      ...validResult,
      tests: [{ name: "adds", file: "a.test.ts", status: "passed" }],
    };
    const parsed = parseFromWorker({ type: "result", runId: "r1", result });
    if (parsed.type !== "result") throw new Error("expected result");
    expect((parsed.result as { tests?: unknown[] }).tests).toHaveLength(1);
  });

  it("degrades a malformed tests list to undefined instead of rejecting the run (Story 6.1)", () => {
    // A bad status enum must NOT fail the whole result — the daemon still gets its run.
    const result = {
      ...validResult,
      tests: [{ name: "adds", file: "a.test.ts", status: "bogus" }],
    };
    const parsed = parseFromWorker({ type: "result", runId: "r1", result });
    if (parsed.type !== "result") throw new Error("expected result");
    expect((parsed.result as { tests?: unknown }).tests).toBeUndefined();
    // The rest of the result survived.
    expect((parsed.result as { passed: number }).passed).toBe(1);
  });
});
