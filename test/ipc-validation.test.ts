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
});
