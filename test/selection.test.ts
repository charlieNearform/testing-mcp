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
      confidence: { level: "high", reasons: [] },
    });
  });

  it("defers to git static-graph when a source changed but no map exists (Story 3.1)", () => {
    expect(SelectionEngine.plan({ changedFiles: ["a.ts"], map: null })).toMatchObject({
      strategy: "changed-only",
    });
  });

  it("selects exactly the mapped tests, no static-graph union, when every changed source is known (AC2, 6.8 AC1)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: mapWith({ "a.ts": ["a.test.ts", "smoke.test.ts"] }, { alwaysRun: ["heavy.test.ts"] }),
    });
    // A fully-mapped change is provably complete on its own (Story 6.8 AC1) — the git
    // static-graph pass is HEAD-scoped and only needed as a bound for genuine uncertainty
    // (Story 6.7's static-graph-interplay note), so it must not run here.
    expect(plan).toMatchObject({ strategy: "incremental", union: false, confidence: { level: "high", reasons: [] } });
    if (plan.strategy === "incremental") {
      expect(plan.testFiles).toEqual(["a.test.ts", "heavy.test.ts", "smoke.test.ts"]);
    }
  });

  it("bounds a MODIFIED unmapped source (not full) but flags degraded confidence (Story 6.8)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["mystery.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
    });
    expect(plan).toMatchObject({ strategy: "incremental", union: true });
    expect(plan.confidence.level).toBe("degraded");
    expect(plan.confidence.reasons.join(" ")).toContain("mystery.ts");
    expect(plan.confidence.reasons.join(" ")).toContain("modified or deleted source");
  });

  it("bounds a NEW (untracked) unmapped source via the static-graph union, degraded (Story 6.6/6.8)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["src/date.ts", "test/date.test.ts"],
      addedFiles: ["src/date.ts", "test/date.test.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
    });
    expect(plan).toMatchObject({ strategy: "incremental", union: true });
    if (plan.strategy === "incremental") {
      expect(plan.testFiles).toEqual(["test/date.test.ts"]);
      expect(plan.reason).toContain("unmapped changes bounded by --changed");
      expect(plan.confidence.level).toBe("degraded");
      expect(plan.confidence.reasons.join(" ")).toContain("new source");
    }
  });

  it("a NEW unmapped source is HIGH confidence when the project has no dynamic imports", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["src/date.ts", "test/date.test.ts"],
      addedFiles: ["src/date.ts", "test/date.test.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
      dynamicImportsPresent: false,
    });
    expect(plan).toMatchObject({ strategy: "incremental", union: true });
    // The only named risk for a NEW source is a dynamic-import blind spot; ruled out -> HIGH.
    expect(plan.confidence).toEqual({ level: "high", reasons: [] });
  });

  it("a NEW unmapped source stays degraded, naming the file, when dynamic imports ARE present", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["src/date.ts", "test/date.test.ts"],
      addedFiles: ["src/date.ts", "test/date.test.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
      dynamicImportsPresent: true,
    });
    expect(plan.confidence.level).toBe("degraded");
    expect(plan.confidence.reasons.join(" ")).toContain("dynamic imports may be missed");
    expect(plan.confidence.reasons.join(" ")).toContain("src/date.ts");
  });

  it("strict forces the full suite for an unmapped source, high confidence (Story 6.8 opt-out)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["src/legacy.ts"],
      addedFiles: [],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
      strict: true,
    });
    expect(plan).toMatchObject({ strategy: "full", confidence: { level: "high", reasons: [] } });
    expect(plan.reason).toContain("strict");
  });

  it("strict forces full even when there is no coverage map at all (Story 6.8 opt-out)", () => {
    const plan = SelectionEngine.plan({ changedFiles: ["src/legacy.ts"], map: null, strict: true });
    expect(plan).toMatchObject({ strategy: "full", confidence: { level: "high", reasons: [] } });
    expect(plan.reason).toContain("strict");
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

describe("SelectionEngine.plan size-based full-run escalation", () => {
  it("never escalates when there is no test-file inventory yet (0 denominator)", () => {
    // 3 selected tests would be well over threshold against any small positive denominator, but
    // there's no inventory to divide by yet -- must never divide-by-zero into a false "full".
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: mapWith({ "a.ts": ["a.test.ts", "b.test.ts", "c.test.ts"] }),
      totalTestFileCount: 0,
    });
    expect(plan).toMatchObject({ strategy: "incremental" });
    if (plan.strategy === "incremental") expect(plan.testFiles).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
  });

  it("also never escalates when totalTestFileCount is simply absent (same as 0)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: mapWith({ "a.ts": ["a.test.ts", "b.test.ts", "c.test.ts"] }),
    });
    expect(plan).toMatchObject({ strategy: "incremental" });
  });

  it("escalates to a full run when the selection exceeds the default 70% threshold", () => {
    // 3 of 4 known test files selected -> 75%, over the 70% default -> escalate.
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: mapWith({ "a.ts": ["a.test.ts", "b.test.ts", "c.test.ts"] }),
      totalTestFileCount: 4,
    });
    expect(plan).toMatchObject({
      strategy: "full",
      confidence: { level: "high", reasons: [] }, // a full run IS complete regardless of why chosen
    });
    expect(plan.reason).toContain("75%");
    expect(plan.reason).toContain("3/4 test files");
  });

  it("does NOT escalate exactly at the threshold boundary (70% is not > 70%)", () => {
    // 7 of 10 known test files selected -> exactly 70%, not over the default threshold.
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: mapWith({
        "a.ts": ["t1.test.ts", "t2.test.ts", "t3.test.ts", "t4.test.ts", "t5.test.ts", "t6.test.ts", "t7.test.ts"],
      }),
      totalTestFileCount: 10,
    });
    expect(plan).toMatchObject({ strategy: "incremental" });
    if (plan.strategy === "incremental") expect(plan.testFiles).toHaveLength(7);
  });

  it("respects TEST_MCP_INCREMENTAL_FULL_THRESHOLD when set", () => {
    const prior = process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD;
    process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD = "0.5";
    try {
      // 3 of 4 -> 75%, over the lowered 50% threshold -> escalate (would NOT escalate at the
      // default 70% threshold used by the sibling test above with the same map).
      const plan = SelectionEngine.plan({
        changedFiles: ["a.ts"],
        map: mapWith({ "a.ts": ["a.test.ts", "b.test.ts", "c.test.ts"] }),
        totalTestFileCount: 4,
      });
      expect(plan).toMatchObject({ strategy: "full" });
    } finally {
      if (prior === undefined) delete process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD;
      else process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD = prior;
    }
  });

  // Explicit `files: [...]` requests never reach this check at all -- resolveSelection's explicit
  // branch (src/orchestrator/index.ts) returns before ever calling SelectionEngine.plan(), so
  // there's no plan()-level input that represents "explicit files" directly. What IS assertable
  // here is the other half of the same guarantee the spec requires: the escalation is wired into
  // ONLY the final auto-computed incremental return, so a plan() branch that resolves without
  // reaching it (like "only test files changed", below) ignores totalTestFileCount even when a
  // naive fraction would be far over threshold -- structurally the same bypass explicit files get.
  it("does not escalate the 'only test files changed' branch even when it would be over threshold", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.test.ts", "b.test.ts"],
      map: mapWith({}),
      // If checked here, 2/1 would be 200% -- nowhere near escalatable; it must not be checked at all.
      totalTestFileCount: 1,
    });
    expect(plan).toMatchObject({ strategy: "incremental", reason: "only test files changed" });
    if (plan.strategy === "incremental") expect(plan.testFiles).toEqual(["a.test.ts", "b.test.ts"]);
  });

  // `strict`/`changed-only` both resolve to their OWN branch before the size check is ever
  // reached (the check only lives in the final auto-computed incremental return) -- verified
  // directly, not just inferred from "the code only has one call site."
  it("does not escalate the 'strict, no map' branch even when it would be over threshold", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: null,
      strict: true,
      totalTestFileCount: 1,
    });
    expect(plan).toMatchObject({ strategy: "full", reason: "source changed; no coverage map (strict)" });
  });

  it("does not escalate the 'changed-only, no map' branch even when it would be over threshold", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: null,
      totalTestFileCount: 1,
    });
    expect(plan).toMatchObject({ strategy: "changed-only" });
  });

  // Found via adversarial review: Number("") is 0 (finite), so a naive Number.isFinite guard does
  // NOT catch an accidentally-blank env value -- it would silently make the threshold 0, escalating
  // every incremental selection instead of falling back to the default as intended.
  it("falls back to the default threshold when the env override is blank", () => {
    const prior = process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD;
    process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD = "";
    try {
      // 1 of 4 -> 25%, well under the default 70% -- if the blank string had silently become 0,
      // this would escalate; it must not.
      const plan = SelectionEngine.plan({
        changedFiles: ["a.ts"],
        map: mapWith({ "a.ts": ["a.test.ts"] }),
        totalTestFileCount: 4,
      });
      expect(plan).toMatchObject({ strategy: "incremental" });
    } finally {
      if (prior === undefined) delete process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD;
      else process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD = prior;
    }
  });

  it("falls back to the default threshold when the env override is out of (0, 1] range", () => {
    const prior = process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD;
    try {
      for (const bad of ["0", "-0.5", "1.5"]) {
        process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD = bad;
        // Same 25%-of-4 case as above -- under the real default (0.7) regardless of `bad`'s
        // nonsensical value (always-escalate at 0/negative, never-escalate at >1 would both be
        // wrong to observe here if the guard failed).
        const plan = SelectionEngine.plan({
          changedFiles: ["a.ts"],
          map: mapWith({ "a.ts": ["a.test.ts"] }),
          totalTestFileCount: 4,
        });
        expect(plan).toMatchObject({ strategy: "incremental" });
      }
    } finally {
      if (prior === undefined) delete process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD;
      else process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD = prior;
    }
  });

  // Found via adversarial review: `selected.size` can exceed `totalTestFileCount` (a just-added
  // test file the inventory hasn't reconciled yet is still a valid selection target) -- the
  // reported percentage must be capped, not read as a nonsensical "150% of the suite."
  it("caps the reported percentage at 100% when the selection exceeds the known total", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: mapWith({ "a.ts": ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts", "f.test.ts"] }),
      totalTestFileCount: 4, // 6 selected > 4 known -> would be 150% uncapped
    });
    expect(plan).toMatchObject({ strategy: "full" });
    expect(plan.reason).toContain("100%");
    expect(plan.reason).toContain("6/4 test files");
    expect(plan.reason).not.toContain("150%");
  });
});

describe("SelectionEngine.plan confidence (Story 6.8)", () => {
  it("is high when all changed sources are mapped", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }),
    });
    expect(plan.confidence).toEqual({ level: "high", reasons: [] });
  });

  it("is high for a full-suite trigger (a full run is complete)", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["i18n.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }, { fullSuiteTriggers: ["i18n.ts"] }),
    });
    expect(plan).toMatchObject({ strategy: "full" });
    expect(plan.confidence).toEqual({ level: "high", reasons: [] });
  });

  it("is high when changed files are undeterminable (full run)", () => {
    expect(SelectionEngine.plan({ changedFiles: null, map: null }).confidence).toEqual({
      level: "high",
      reasons: [],
    });
  });

  it("is degraded when a source changed but no coverage map exists", () => {
    const plan = SelectionEngine.plan({ changedFiles: ["a.ts"], map: null });
    expect(plan).toMatchObject({ strategy: "changed-only" });
    expect(plan.confidence.level).toBe("degraded");
    expect(plan.confidence.reasons.join(" ")).toContain("no coverage map");
  });

  it("does not degrade merely because unmeasurable (alwaysRun) tests exist", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts"],
      map: mapWith({ "a.ts": ["a.test.ts"] }, { alwaysRun: ["heavy.test.ts"] }),
    });
    expect(plan.confidence).toEqual({ level: "high", reasons: [] });
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

  it("keeps non-JS build/test configs via keep-always even against a broad ignore", () => {
    const files = [
      "babel.config.json",
      "jest.config.json",
      ".mocharc.yml",
      ".swcrc",
      ".env.test",
      "vitest.workspace.json",
    ];
    // A user pattern that would otherwise drop all of these.
    expect(filterChangedPaths(files, ["*.json", "*.yml", ".swcrc", ".env.*"])).toEqual(files);
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
