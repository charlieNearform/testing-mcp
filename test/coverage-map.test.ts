import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  buildCoverageMap,
  extractCoveredSources,
  type FileMeasurement,
} from "../src/coverage/index.ts";

const ROOT = "/proj";

/** Build a `measure` stub from a rel-testfile -> covered-source-rels table. */
function stubMeasure(table: Record<string, string[]>, unmeasured: string[] = []) {
  return async (abs: string): Promise<FileMeasurement> => {
    const rel = path.relative(ROOT, abs);
    if (unmeasured.includes(rel)) return { sources: [], measured: false };
    return { sources: table[rel] ?? [], measured: true };
  };
}

describe("buildCoverageMap (pure)", () => {
  it("builds a fresh source->test reverse map", async () => {
    const { file, summary } = await buildCoverageMap({
      projectRoot: ROOT,
      projectId: "p1",
      targetTestFiles: [`${ROOT}/a.test.ts`, `${ROOT}/b.test.ts`],
      existing: null,
      measure: stubMeasure({ "a.test.ts": ["a.ts", "shared.ts"], "b.test.ts": ["b.ts", "shared.ts"] }),
    });

    expect(file.schemaVersion).toBe(1);
    expect(file.projectId).toBe("p1");
    expect(file.map["a.ts"].tests).toEqual(["a.test.ts"]);
    expect(file.map["b.ts"].tests).toEqual(["b.test.ts"]);
    expect(file.map["shared.ts"].tests).toEqual(["a.test.ts", "b.test.ts"]);
    expect(summary.incremental).toBe(false);
    expect(summary.measuredTestFiles).toBe(2);
    expect(summary.sourceFilesMapped).toBe(3);
  });

  it("re-measures only the given files and preserves other edges (incremental)", async () => {
    const first = await buildCoverageMap({
      projectRoot: ROOT,
      projectId: "p1",
      targetTestFiles: [`${ROOT}/a.test.ts`, `${ROOT}/b.test.ts`],
      existing: null,
      measure: stubMeasure({ "a.test.ts": ["a.ts", "shared.ts"], "b.test.ts": ["b.ts", "shared.ts"] }),
    });

    // a.test.ts now covers c.ts instead of a.ts; b.test.ts is untouched.
    const { file, summary } = await buildCoverageMap({
      projectRoot: ROOT,
      projectId: "p1",
      targetTestFiles: [`${ROOT}/a.test.ts`],
      existing: first.file,
      measure: stubMeasure({ "a.test.ts": ["c.ts", "shared.ts"] }),
    });

    expect(summary.incremental).toBe(true);
    expect(summary.measuredTestFiles).toBe(1);
    // Old a.ts edge dropped, new c.ts edge added.
    expect(file.map["a.ts"]).toBeUndefined();
    expect(file.map["c.ts"].tests).toEqual(["a.test.ts"]);
    // b.test.ts's edges preserved without re-measuring it.
    expect(file.map["b.ts"].tests).toEqual(["b.test.ts"]);
    // shared.ts still attributed to both.
    expect(file.map["shared.ts"].tests).toEqual(["a.test.ts", "b.test.ts"]);
  });

  it("records unmeasured test files and adds no edges for them (no silent success)", async () => {
    const { file, summary } = await buildCoverageMap({
      projectRoot: ROOT,
      projectId: "p1",
      targetTestFiles: [`${ROOT}/heavy.test.ts`, `${ROOT}/a.test.ts`],
      existing: null,
      measure: stubMeasure({ "a.test.ts": ["a.ts"] }, ["heavy.test.ts"]),
    });

    expect(summary.unmeasuredTestFiles).toEqual(["heavy.test.ts"]);
    expect(summary.measuredTestFiles).toBe(1);
    expect(Object.values(file.map).every((e) => !e.tests.includes("heavy.test.ts"))).toBe(true);
  });
});

describe("extractCoveredSources", () => {
  const cov = {
    "/proj/a.ts": { s: { "0": 3, "1": 0 } }, // executed
    "/proj/untouched.ts": { s: { "0": 0 } }, // not executed
    "/proj/a.test.ts": { s: { "0": 5 } }, // the test file itself
    "/proj/__tests__/helper.ts": { s: { "0": 1 } }, // test dir
    "/proj/node_modules/dep/index.js": { s: { "0": 9 } }, // dependency
    "/other/x.ts": { s: { "0": 1 } }, // out of tree
  };

  it("keeps only executed, in-tree, non-test source files", () => {
    expect(extractCoveredSources(cov, "/proj", "/proj/a.test.ts")).toEqual(["a.ts"]);
  });
});
