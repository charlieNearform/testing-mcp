import { describe, it, expect } from "vitest";
import { SelectionEngine, isTestFile } from "../src/selection/index.ts";
import type { CoverageMapFile } from "../src/coverage/index.ts";

function mapWith(
  map: Record<string, string[]>,
  opts: { fullSuiteTriggers?: string[]; alwaysRun?: string[] } = {},
): CoverageMapFile {
  return {
    schemaVersion: 3,
    projectId: "p1",
    updatedAt: "now",
    map: Object.fromEntries(Object.entries(map).map(([s, tests]) => [s, { tests, lastMeasured: "now" }])),
    fullSuiteTriggers: opts.fullSuiteTriggers ?? [],
    alwaysRun: opts.alwaysRun ?? [],
  };
}

describe("SelectionEngine.plan", () => {
  it("runs the full suite when changed files are undeterminable (non-git)", () => {
    expect(SelectionEngine.plan({ changedFiles: null, map: null })).toMatchObject({ strategy: "full" });
  });

  it("returns an empty incremental plan when nothing changed", () => {
    expect(SelectionEngine.plan({ changedFiles: [], map: mapWith({}) })).toMatchObject({
      strategy: "incremental",
      testFiles: [],
      union: false,
    });
  });

  it("runs only the changed test files when no source changed (AC1)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.test.ts", "b.test.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
    });
    expect(plan).toEqual({
      strategy: "incremental",
      reason: "only test files changed",
      testFiles: ["a.test.ts", "b.test.ts"],
      union: false,
    });
  });

  it("defers to git static-graph when a source changed but no map exists (Story 3.1)", () => {
    expect(SelectionEngine.plan({ changedFiles: ["a.ts"], map: null })).toMatchObject({
      strategy: "changed-only",
    });
  });

  it("selects mapped tests unioned with static graph when a known source changed (AC2)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: mapWith({ "a.ts": ["a.test.ts", "smoke.test.ts"] }, { alwaysRun: ["heavy.test.ts"] }),
    });
    expect(plan).toMatchObject({ strategy: "incremental", union: true });
    if (plan.strategy === "incremental") {
      expect(plan.testFiles).toEqual(["a.test.ts", "heavy.test.ts", "smoke.test.ts"]);
    }
  });

  it("runs the full suite when a changed source is unknown to the map (AC3)", () => {
    expect(SelectionEngine.plan({ changedFiles: ["mystery.ts"], map: mapWith({ "a.ts": ["a.test.ts"] }) })).toMatchObject(
      { strategy: "full" },
    );
  });

  it("runs the full suite when a changed source is a full-suite trigger", () => {
    expect(
      SelectionEngine.plan({
        changedFiles: ["i18n.ts"],
        map: mapWith({ "a.ts": ["a.test.ts"] }, { fullSuiteTriggers: ["i18n.ts"] }),
      }),
    ).toMatchObject({ strategy: "full" });
  });

  it("includes changed test files alongside mapped tests for a source change", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts", "z.test.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
    });
    if (plan.strategy === "incremental") {
      expect(plan.testFiles).toEqual(["a.test.ts", "z.test.ts"]);
    } else {
      throw new Error(`expected incremental, got ${plan.strategy}`);
    }
  });
});

describe("isTestFile", () => {
  it("recognises test/spec files and __tests__ dirs", () => {
    expect(isTestFile("a.test.ts")).toBe(true);
    expect(isTestFile("a.spec.tsx")).toBe(true);
    expect(isTestFile("src/__tests__/a.ts")).toBe(true);
    expect(isTestFile("src/a.ts")).toBe(false);
  });
});
