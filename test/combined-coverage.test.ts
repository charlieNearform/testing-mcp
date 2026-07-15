import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  COVERAGE_DATA_SCHEMA_VERSION,
  coverageDataPath,
  loadCoverageData,
  saveCoverageData,
  updateCoverageData,
  combineCoverage,
  coveredSourceFiles,
  type CoverageDataFile,
  type TestCoverage,
  type IstanbulCoverageData,
} from "../src/coverage/combined.ts";

/**
 * Story 6.10 — combined incremental coverage. These drive the pure merge/persist/staleness logic
 * with hand-built istanbul-shaped coverage data (no Vitest run), plus a temp-dir persistence round-trip.
 */

const ROOT = "/proj";

/** Minimal istanbul FileCoverage for `absPath`: `total` statements, first `covered` of them hit. */
function fileCov(absPath: string, total: number, covered: number) {
  const statementMap: Record<string, unknown> = {};
  const s: Record<string, number> = {};
  for (let i = 0; i < total; i++) {
    statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 5 } };
    s[i] = i < covered ? 1 : 0;
  }
  return { path: absPath, statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} };
}

function test(data: IstanbulCoverageData, sourceHashes: Record<string, string>): TestCoverage {
  return { measuredAt: "now", sourceHashes, data };
}

function dataFile(tests: Record<string, TestCoverage>): CoverageDataFile {
  return { schemaVersion: COVERAGE_DATA_SCHEMA_VERSION, projectId: "p", updatedAt: "now", tests };
}

const alwaysExists = () => true;

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("combineCoverage (Story 6.10)", () => {
  it("unions each test file's latest coverage (two halves -> full)", () => {
    // a.ts has 4 statements; test A covers the first 2, test B the last 2 -> combined 100%.
    const file = dataFile({
      "a.test.ts": test({ "/proj/src/a.ts": fileCov("/proj/src/a.ts", 4, 2) }, { "src/a.ts": "h1" }),
      "b.test.ts": test(
        { "/proj/src/a.ts": { ...fileCov("/proj/src/a.ts", 4, 0), s: { "0": 0, "1": 0, "2": 1, "3": 1 } } },
        { "src/a.ts": "h1" },
      ),
    });
    const combined = combineCoverage(file, ROOT, { "src/a.ts": "h1" }, new Set());
    expect(combined).not.toBeNull();
    expect(combined!.combined).toBe(true);
    expect(combined!.total.statements).toBe(100);
    expect(combined!.files.map((f) => f.file)).toEqual(["src/a.ts"]);
    expect(combined!.confidence.level).toBe("high");
  });

  it("flags a source stale + degraded when its hash changed since measurement", () => {
    const file = dataFile({
      "a.test.ts": test({ "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 2) }, { "src/a.ts": "old" }),
    });
    const combined = combineCoverage(file, ROOT, { "src/a.ts": "new" }, new Set());
    expect(combined!.files[0].stale).toBe(true);
    expect(combined!.confidence.level).toBe("degraded");
    expect(combined!.confidence.reasons.join(" ")).toContain("src/a.ts");
  });

  it("flags a source stale when two tests measured DIFFERENT versions of it (review F1)", () => {
    // Test A measured v1, test B measured v2; disk is now v2. The merge mixes versions, so even
    // though disk matches B, the report must be degraded (A's contribution is a stale version).
    const file = dataFile({
      "a.test.ts": test({ "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 1) }, { "src/a.ts": "v1" }),
      "b.test.ts": test({ "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 2) }, { "src/a.ts": "v2" }),
    });
    const combined = combineCoverage(file, ROOT, { "src/a.ts": "v2" }, new Set());
    expect(combined!.files[0].stale).toBe(true);
    expect(combined!.confidence.level).toBe("degraded");
  });

  it("does NOT flag a zero-hit source as stale when its hash matches (review F2)", () => {
    // src/z.ts is loaded but has no executed statements; it must still be hashed and NOT stale.
    const file = dataFile({
      "a.test.ts": test(
        { "/proj/src/z.ts": fileCov("/proj/src/z.ts", 3, 0) },
        { "src/z.ts": "h1" },
      ),
    });
    const combined = combineCoverage(file, ROOT, { "src/z.ts": "h1" }, new Set(["src/z.ts"]));
    expect(combined!.files[0].file).toBe("src/z.ts");
    expect(combined!.files[0].stale).toBeUndefined();
    expect(combined!.confidence.level).toBe("high");
  });

  it("marks freshly-measured, non-stale sources with `fresh`", () => {
    const file = dataFile({
      "a.test.ts": test({ "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 2) }, { "src/a.ts": "h1" }),
    });
    const combined = combineCoverage(file, ROOT, { "src/a.ts": "h1" }, new Set(["src/a.ts"]));
    expect(combined!.files[0].fresh).toBe(true);
    expect(combined!.files[0].stale).toBeUndefined();
  });

  it("excludes test files and node_modules from the report", () => {
    const file = dataFile({
      "a.test.ts": test(
        {
          "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 2),
          "/proj/a.test.ts": fileCov("/proj/a.test.ts", 2, 2),
          "/proj/node_modules/x/i.js": fileCov("/proj/node_modules/x/i.js", 2, 2),
        },
        { "src/a.ts": "h1" },
      ),
    });
    const combined = combineCoverage(file, ROOT, { "src/a.ts": "h1" }, new Set());
    expect(combined!.files.map((f) => f.file)).toEqual(["src/a.ts"]);
  });

  it("skips an unmergeable (corrupt) entry instead of failing the whole report (review F6)", () => {
    const file = dataFile({
      "good.test.ts": test({ "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 2) }, { "src/a.ts": "h1" }),
      "bad.test.ts": test({ "/proj/src/b.ts": { garbage: true } as unknown as object }, { "src/b.ts": "h2" }),
    });
    const combined = combineCoverage(file, ROOT, { "src/a.ts": "h1", "src/b.ts": "h2" }, new Set());
    // The good entry still produces a report.
    expect(combined!.files.some((f) => f.file === "src/a.ts")).toBe(true);
  });

  it("returns null when there is no coverage data", () => {
    expect(combineCoverage(dataFile({}), ROOT, {}, new Set())).toBeNull();
  });
});

describe("coveredSourceFiles (Story 6.10)", () => {
  it("returns project sources incl. zero-hit, excluding tests/node_modules/out-of-tree", () => {
    const data = {
      "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 0), // zero-hit still included
      "/proj/src/b.ts": fileCov("/proj/src/b.ts", 2, 2),
      "/proj/a.test.ts": fileCov("/proj/a.test.ts", 1, 1),
      "/proj/node_modules/x.js": fileCov("/proj/node_modules/x.js", 1, 1),
      "/other/c.ts": fileCov("/other/c.ts", 1, 1),
    };
    expect(coveredSourceFiles(data, ROOT).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("coverage-data persistence (Story 6.10)", () => {
  it("round-trips and rejects a wrong schemaVersion", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-covdata-"));
    const file = dataFile({
      "a.test.ts": test({ "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 2) }, { "src/a.ts": "h1" }),
    });
    saveCoverageData(dir, file);
    expect(loadCoverageData(dir)).toEqual(file);

    fs.writeFileSync(coverageDataPath(dir), JSON.stringify({ ...file, schemaVersion: 999 }));
    expect(loadCoverageData(dir)).toBeNull();
  });

  it("refreshes measured tests, carries live ones, and prunes deleted test files (review F3)", () => {
    const existing = dataFile({
      "a.test.ts": test({ "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 1) }, { "src/a.ts": "old-a" }),
      "b.test.ts": test({ "/proj/src/b.ts": fileCov("/proj/src/b.ts", 2, 2) }, { "src/b.ts": "h-b" }),
      "gone.test.ts": test({ "/proj/src/g.ts": fileCov("/proj/src/g.ts", 2, 2) }, { "src/g.ts": "h-g" }),
    });
    // Re-measure a.test.ts; b.test.ts still exists; gone.test.ts was deleted.
    const updated = updateCoverageData(
      existing,
      "p",
      "later",
      { "a.test.ts": test({ "/proj/src/a.ts": fileCov("/proj/src/a.ts", 2, 2) }, { "src/a.ts": "new-a" }) },
      (t) => t !== "gone.test.ts",
    );
    expect(Object.keys(updated.tests).sort()).toEqual(["a.test.ts", "b.test.ts"]); // gone pruned
    expect(updated.tests["a.test.ts"].measuredAt).toBe("later");
    expect(updated.tests["a.test.ts"].sourceHashes).toEqual({ "src/a.ts": "new-a" });
    expect(updated.tests["b.test.ts"].measuredAt).toBe("now"); // carried
  });
});
