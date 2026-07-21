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

  it("accepts a well-formed config message (Story 8.1)", () => {
    const msg = { type: "config", runId: "r1", testTimeoutMs: 5000 };
    expect(parseFromWorker(msg)).toEqual(msg);
  });

  it("accepts a config message without testTimeoutMs (vitest-pool worker-start retry heartbeat)", () => {
    // testTimeoutMs is optional so a pool-start-retry heartbeat can resend `config` purely to
    // reset the orchestrator's stall watchdog even when no real testTimeout is known yet.
    const msg = { type: "config", runId: "r1" };
    expect(parseFromWorker(msg)).toEqual(msg);
  });

  it("rejects a config message with a non-numeric testTimeoutMs", () => {
    expect(() => parseFromWorker({ type: "config", runId: "r1", testTimeoutMs: "5000" })).toThrow();
  });

  it("rejects a config message missing runId", () => {
    expect(() => parseFromWorker({ type: "config", testTimeoutMs: 5000 })).toThrow();
  });

  it("accepts a well-formed case-start message (Story 8.1)", () => {
    const msg = { type: "case-start", runId: "r1", file: "a.test.ts", name: "adds" };
    expect(parseFromWorker(msg)).toEqual(msg);
  });

  it("rejects a case-start message missing name", () => {
    expect(() => parseFromWorker({ type: "case-start", runId: "r1", file: "a.test.ts" })).toThrow();
  });

  it("accepts a well-formed case-result message for each status (Story 8.1)", () => {
    for (const status of ["passed", "failed", "skipped"] as const) {
      const msg = { type: "case-result", runId: "r1", file: "a.test.ts", name: "adds", status };
      expect(parseFromWorker(msg)).toEqual(msg);
    }
  });

  it("rejects a case-result message with an invalid status", () => {
    expect(() =>
      parseFromWorker({
        type: "case-result",
        runId: "r1",
        file: "a.test.ts",
        name: "adds",
        status: "pending",
      }),
    ).toThrow();
  });

  it("accepts a well-formed phase-progress message (Story 8.1)", () => {
    const msg = { type: "phase-progress", runId: "r1", phase: "coverage", completed: 1, total: 3 };
    expect(parseFromWorker(msg)).toEqual(msg);
  });

  it("rejects a phase-progress message with an unknown phase", () => {
    expect(() =>
      parseFromWorker({ type: "phase-progress", runId: "r1", phase: "bogus", completed: 1, total: 3 }),
    ).toThrow();
  });
});
