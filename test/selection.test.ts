import { describe, it, expect } from "vitest";
import {
  SelectionEngine,
  isTestFile,
  filterChangedPaths,
  DEFAULT_IGNORE_PATTERNS,
} from "../src/selection/index.ts";
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

  it("bounds a NEW (untracked) unmapped source via the static-graph union, not full (Story 6.6)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["src/date.ts", "test/date.test.ts"],
      addedFiles: ["src/date.ts", "test/date.test.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
    });
    expect(plan).toMatchObject({ strategy: "incremental", union: true });
    if (plan.strategy === "incremental") {
      expect(plan.testFiles).toEqual(["test/date.test.ts"]);
      expect(plan.reason).toContain("new files bounded by --changed");
    }
  });

  it("still runs full for a MODIFIED unmapped source not in addedFiles (Story 6.6)", () => {
    expect(
      SelectionEngine.plan({
        changedFiles: ["src/legacy.ts"],
        addedFiles: [],
        map: mapWith({ "a.ts": ["a.test.ts"] }),
      }),
    ).toMatchObject({ strategy: "full" });
  });

  it("plans a lone new source as union:true with no explicit testFiles (Story 6.6)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["src/date.ts"],
      addedFiles: ["src/date.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
    });
    expect(plan).toMatchObject({ strategy: "incremental", union: true });
    if (plan.strategy === "incremental") {
      expect(plan.testFiles).toEqual([]);
    }
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

describe("filterChangedPaths (Story 6.5)", () => {
  const defaults = [...DEFAULT_IGNORE_PATTERNS];

  it("drops test-irrelevant paths via the built-in default set", () => {
    const files = [
      "README.md",
      "docs/guide.mdx",
      "notes.txt",
      "docs/deep/page.md",
      ".gitignore",
      "CLAUDE.md",
      ".vscode/settings.json",
      "LICENSE",
      ".github/workflows/ci.yml",
    ];
    expect(filterChangedPaths(files, defaults)).toEqual([]);
  });

  it("keeps code and build/test config via keep-always even against a matching ignore pattern", () => {
    const files = ["package.json", "tsconfig.json", "src/x.ts"];
    // A user pattern that would otherwise match all of these.
    expect(filterChangedPaths(files, [...defaults, "*.json", "src/**"])).toEqual([
      "package.json",
      "tsconfig.json",
      "src/x.ts",
    ]);
  });

  it("keeps lockfiles, config files, and vitest.setup via keep-always", () => {
    const files = ["pnpm-lock.yaml", "vitest.config.ts", "vitest.setup.ts", "tsconfig.build.json"];
    expect(filterChangedPaths(files, ["*.yaml", "*.ts", "tsconfig*.json"])).toEqual(files);
  });

  it("keeps relevant files while dropping only the matched ones (mixed set)", () => {
    const files = ["README.md", "src/app.ts", ".gitignore"];
    expect(filterChangedPaths(files, defaults)).toEqual(["src/app.ts"]);
  });

  it("keeps .mts/.cts modules and uppercase-extension sources via keep-always", () => {
    // isTestFile recognizes .mts/.cts; keep-always must too, and be case-insensitive.
    const files = ["feature.test.mts", "util.cts", "Widget.TS"];
    expect(filterChangedPaths(files, ["*.mts", "*.cts", "*.ts"])).toEqual(files);
  });

  it("supports the documented matcher forms", () => {
    // *.ext basename glob at any depth
    expect(filterChangedPaths(["a/b/foo.snap"], ["*.snap"])).toEqual([]);
    // bare name matches basename at any depth
    expect(filterChangedPaths(["config/robots.txt", "robots.txt"], ["robots.txt"])).toEqual([]);
    // dir/** subtree
    expect(filterChangedPaths(["assets/img/logo.png", "assets/x.json"], ["assets/**"])).toEqual([]);
    // leading-/ root anchoring: only matches at the root
    expect(filterChangedPaths(["build.log", "nested/build.log"], ["/build.log"])).toEqual([
      "nested/build.log",
    ]);
    // a non-code file that matches nothing survives
    expect(filterChangedPaths(["data.csv"], ["*.snap"])).toEqual(["data.csv"]);
  });

  it("ignores comment and blank lines in the pattern list", () => {
    const patterns = ["# a comment", "", "   ", "*.snap"];
    expect(filterChangedPaths(["foo.snap", "keep.csv"], patterns)).toEqual(["keep.csv"]);
    // A comment must not accidentally act as a pattern.
    expect(filterChangedPaths(["# a comment"], ["# a comment"])).toEqual(["# a comment"]);
  });
});
