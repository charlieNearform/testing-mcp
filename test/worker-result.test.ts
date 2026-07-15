import { describe, it, expect } from "vitest";
import { mapModulesToResult, mapCoverageSummary } from "../src/worker/index.ts";

/**
 * Story 6.1 — mapModulesToResult now emits a per-test `tests` list (every case that ran, by
 * status) in the SAME pass that builds counts/failures, bounded by a cap. These tests drive the
 * pure mapper with minimal structural fakes of the Vitest reporter objects (no Vitest run).
 */

type State = "passed" | "failed" | "skipped" | "pending";

function fakeCase(id: string, fullName: string, moduleId: string, state: State) {
  return {
    id,
    fullName,
    module: { moduleId },
    result: () => ({ state, errors: state === "failed" ? [{ message: "boom" }] : [] }),
  };
}

function fakeModule(moduleId: string, cases: ReturnType<typeof fakeCase>[]) {
  return {
    moduleId,
    diagnostic: () => ({ duration: 1 }),
    errors: () => [],
    children: { allTests: () => cases },
  };
}

describe("mapModulesToResult per-test detail (Story 6.1)", () => {
  it("lists every case that ran with a normalized status (passed/failed/skipped)", () => {
    const mod = fakeModule("/proj/a.test.ts", [
      fakeCase("1", "adds", "/proj/a.test.ts", "passed"),
      fakeCase("2", "subtracts", "/proj/a.test.ts", "failed"),
      fakeCase("3", "todo", "/proj/a.test.ts", "skipped"),
      fakeCase("4", "hangs", "/proj/a.test.ts", "pending"),
    ]);
    const result = mapModulesToResult(
      [mod],
      [],
      10,
      { strategy: "full", reason: "full suite" },
      true,
    );

    expect(result.tests).toEqual([
      { name: "adds", file: "/proj/a.test.ts", status: "passed" },
      { name: "subtracts", file: "/proj/a.test.ts", status: "failed" },
      { name: "todo", file: "/proj/a.test.ts", status: "skipped" },
      // pending is reported as failed, consistent with the counts.
      { name: "hangs", file: "/proj/a.test.ts", status: "failed" },
    ]);
    expect(result.testsTruncated).toBeUndefined();
    // Failing/pending still get a `failures` entry with a message (unchanged behaviour).
    expect(result.failures).toHaveLength(2);
    expect(result.passed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(2);
  });

  it("caps the tests list and flags testsTruncated for a very large suite", () => {
    const cases = Array.from({ length: 1500 }, (_, i) =>
      fakeCase(String(i), "t" + i, "/proj/big.test.ts", "passed"),
    );
    const result = mapModulesToResult(
      [fakeModule("/proj/big.test.ts", cases)],
      [],
      10,
      { strategy: "full", reason: "full suite" },
      true,
    );

    expect(result.testsTruncated).toBe(true);
    expect(result.tests).toHaveLength(1000);
    // Counts remain accurate even though the detail list is capped.
    expect(result.passed).toBe(1500);
    expect(result.total).toBe(1500);
  });

  it("includes unhandled errors in the tests list so it matches the failed count", () => {
    const mod = fakeModule("/proj/a.test.ts", [fakeCase("1", "adds", "/proj/a.test.ts", "passed")]);
    const result = mapModulesToResult(
      [mod],
      [{ message: "unhandled rejection" }],
      10,
      { strategy: "full", reason: "full suite" },
      true,
    );
    // failed (1 unhandled) is reflected in the tests list, not just in `failures`.
    expect(result.failed).toBe(1);
    expect(result.tests).toContainEqual({ name: "(unhandled error)", file: "", status: "failed" });
    expect(result.tests?.filter((t) => t.status === "passed")).toHaveLength(1);
  });

  it("maps coverage-summary.json to the contract, relativizing file paths (Story 6.3)", () => {
    const json = {
      total: {
        statements: { pct: 92.5 },
        branches: { pct: 80 },
        functions: { pct: 100 },
        lines: { pct: 92.5 },
      },
      "/proj/src/math.ts": {
        statements: { pct: 100 },
        branches: { pct: 100 },
        functions: { pct: 100 },
        lines: { pct: 100 },
      },
    };
    const cov = mapCoverageSummary(json, "/proj");
    expect(cov!.total).toEqual({ statements: 92.5, branches: 80, functions: 100, lines: 92.5 });
    expect(cov!.files).toEqual([
      { file: "src/math.ts", statements: 100, branches: 100, functions: 100, lines: 100 },
    ]);
  });

  it("defaults missing coverage metrics to 0 (Story 6.3)", () => {
    const cov = mapCoverageSummary({ total: {} }, "/proj");
    expect(cov!.total).toEqual({ statements: 0, branches: 0, functions: 0, lines: 0 });
    expect(cov!.files).toEqual([]);
  });

  it("coerces a non-numeric pct sentinel to 0 (no NaN%) (Story 6.3)", () => {
    const json = { total: { lines: { pct: "Unknown" as unknown as number } } };
    const cov = mapCoverageSummary(json, "/proj");
    expect(cov!.total.lines).toBe(0);
  });

  it("includes a module load error as a failed test entry", () => {
    const mod = {
      moduleId: "/proj/broken.test.ts",
      diagnostic: () => ({ duration: 0 }),
      errors: () => [{ message: "import failed" }],
      children: { allTests: () => [] },
    };
    const result = mapModulesToResult(
      [mod],
      [],
      5,
      { strategy: "full", reason: "full suite" },
      true,
    );
    expect(result.tests).toEqual([
      { name: "(module load error)", file: "/proj/broken.test.ts", status: "failed" },
    ]);
  });
});
