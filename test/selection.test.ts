import { describe, it, expect } from "vitest";
import {
  SelectionEngine,
  isTestFile,
  filterChangedPaths,
  DEFAULT_IGNORE_PATTERNS,
} from "../src/selection/index.ts";

describe("SelectionEngine.plan (Story 3.8: related-based, no coverage map)", () => {
  it("runs the full suite when changed files are undeterminable (non-git)", () => {
    expect(SelectionEngine.plan({ changedFiles: null })).toMatchObject({
      strategy: "full",
      confidence: { level: "high", reasons: [] },
    });
  });

  it("returns an empty incremental plan when nothing changed", () => {
    expect(SelectionEngine.plan({ changedFiles: [] })).toEqual({
      strategy: "incremental",
      reason: "no changes detected",
      relatedFiles: [],
      confidence: { level: "high", reasons: [] },
    });
  });

  it("runs only the changed test files when no source changed (AC1), high confidence", () => {
    const plan = SelectionEngine.plan({ changedFiles: ["a.test.ts", "b.test.ts"] });
    expect(plan).toEqual({
      strategy: "incremental",
      reason: "only test files changed",
      relatedFiles: ["a.test.ts", "b.test.ts"],
      confidence: { level: "high", reasons: [] },
    });
  });

  it("is high confidence for a test-only change even when the project has dynamic imports", () => {
    // AC6's caveat is about a SOURCE reached only via a dynamic import; a pure test-file change
    // has no source-side static-graph uncertainty at all, dynamic imports or not.
    const plan = SelectionEngine.plan({
      changedFiles: ["a.test.ts"],
      dynamicImportsPresent: true,
    });
    expect(plan.confidence).toEqual({ level: "high", reasons: [] });
  });

  it("resolves a modified source change to a related-based incremental plan, high confidence (no dynamic imports)", () => {
    // dynamicImportsPresent: false is what keeps this high -- with no dynamic-import syntax in the
    // project, `related`'s static graph has no blind spot to flag (Patch F short-circuit).
    const plan = SelectionEngine.plan({ changedFiles: ["a.ts"], dynamicImportsPresent: false });
    expect(plan).toEqual({
      strategy: "incremental",
      reason: "source changed; resolved via Vitest's related static import graph",
      relatedFiles: ["a.ts"],
      confidence: { level: "high", reasons: [] },
    });
  });

  it("bundles both changed sources and changed test files into relatedFiles together", () => {
    const plan = SelectionEngine.plan({ changedFiles: ["a.ts", "z.test.ts"] });
    expect(plan).toMatchObject({ strategy: "incremental" });
    if (plan.strategy === "incremental") {
      expect(plan.relatedFiles).toEqual(["a.ts", "z.test.ts"]);
    }
  });

  it("dedupes relatedFiles", () => {
    const plan = SelectionEngine.plan({ changedFiles: ["a.ts", "a.ts", "b.test.ts"] });
    if (plan.strategy === "incremental") {
      expect(plan.relatedFiles).toEqual(["a.ts", "b.test.ts"]);
    } else {
      throw new Error(`expected incremental, got ${plan.strategy}`);
    }
  });

  describe("AC6: the changed-source dynamic-import caveat (the one residual blind spot)", () => {
    it("a MODIFIED (tracked, not new) source is flagged degraded when dynamic imports are present (Patch F)", () => {
      // A MODIFIED source reached only via a dynamic import() is exactly as invisible to
      // `related`'s static graph as a brand-new one -- new-vs-modified doesn't change whether the
      // dynamic edge can be seen, so it must degrade too (AC6's literal "NEW/modified source").
      const plan = SelectionEngine.plan({
        changedFiles: ["a.ts"],
        addedFiles: [],
        dynamicImportsPresent: true,
      });
      expect(plan.confidence.level).toBe("degraded");
      expect(plan.confidence.reasons.join(" ")).toContain("a.ts");
      expect(plan.confidence.reasons.join(" ")).toContain("dynamic import");
    });

    it("a NEW source is flagged degraded, naming the file, when dynamic imports ARE present", () => {
      const plan = SelectionEngine.plan({
        changedFiles: ["src/date.ts", "test/date.test.ts"],
        addedFiles: ["src/date.ts", "test/date.test.ts"],
        dynamicImportsPresent: true,
      });
      expect(plan).toMatchObject({ strategy: "incremental" });
      expect(plan.confidence.level).toBe("degraded");
      expect(plan.confidence.reasons.join(" ")).toContain("src/date.ts");
      expect(plan.confidence.reasons.join(" ")).toContain("dynamic import");
      if (plan.strategy === "incremental") {
        expect(plan.relatedFiles).toEqual(["src/date.ts", "test/date.test.ts"]);
      }
    });

    it("a NEW source is HIGH confidence when the project has no dynamic imports", () => {
      const plan = SelectionEngine.plan({
        changedFiles: ["src/date.ts", "test/date.test.ts"],
        addedFiles: ["src/date.ts", "test/date.test.ts"],
        dynamicImportsPresent: false,
      });
      expect(plan).toMatchObject({ strategy: "incremental" });
      expect(plan.confidence).toEqual({ level: "high", reasons: [] });
    });

    it("dynamicImportsPresent undefined (caller didn't check) is treated conservatively as 'might have one'", () => {
      const plan = SelectionEngine.plan({
        changedFiles: ["src/date.ts"],
        addedFiles: ["src/date.ts"],
      });
      expect(plan.confidence.level).toBe("degraded");
    });

    it("names ALL changed sources (new AND modified) in the degraded reasons when dynamic imports are present (Patch F)", () => {
      const plan = SelectionEngine.plan({
        changedFiles: ["old.ts", "new.ts"],
        addedFiles: ["new.ts"],
        dynamicImportsPresent: true,
      });
      expect(plan.confidence.level).toBe("degraded");
      // Both the modified (old.ts) and the new (new.ts) source are blind spots to `related` here.
      expect(plan.confidence.reasons.join(" ")).toContain("new.ts");
      expect(plan.confidence.reasons.join(" ")).toContain("old.ts");
    });
  });
});

describe("SelectionEngine.plan size-based full-run escalation", () => {
  it("never escalates when there is no test-file inventory yet (0 denominator)", () => {
    const plan = SelectionEngine.plan({ changedFiles: ["a.ts"], totalTestFileCount: 0 });
    expect(plan).toMatchObject({ strategy: "incremental" });
  });

  it("also never escalates when totalTestFileCount is simply absent (same as 0)", () => {
    const plan = SelectionEngine.plan({ changedFiles: ["a.ts"] });
    expect(plan).toMatchObject({ strategy: "incremental" });
  });

  it("escalates to a full run when the related list exceeds the default 70% threshold", () => {
    // 3 changed files against 4 known test files -> 75%, over the 70% default -> escalate.
    const plan = SelectionEngine.plan({
      changedFiles: ["a.ts", "b.ts", "c.ts"],
      totalTestFileCount: 4,
    });
    expect(plan).toMatchObject({
      strategy: "full",
      confidence: { level: "high", reasons: [] }, // a full run IS complete regardless of why chosen
    });
    expect(plan.reason).toContain("75%");
    expect(plan.reason).toContain("3/4 known test files");
  });

  it("does NOT escalate exactly at the threshold boundary (70% is not > 70%)", () => {
    const changed = ["t1.ts", "t2.ts", "t3.ts", "t4.ts", "t5.ts", "t6.ts", "t7.ts"];
    const plan = SelectionEngine.plan({ changedFiles: changed, totalTestFileCount: 10 });
    expect(plan).toMatchObject({ strategy: "incremental" });
  });

  it("respects TEST_MCP_INCREMENTAL_FULL_THRESHOLD when set", () => {
    const prior = process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD;
    process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD = "0.5";
    try {
      // 3 of 4 -> 75%, over the lowered 50% threshold -> escalate (would NOT escalate at the
      // default 70% threshold used by the sibling test above with the same input).
      const plan = SelectionEngine.plan({
        changedFiles: ["a.ts", "b.ts", "c.ts"],
        totalTestFileCount: 4,
      });
      expect(plan).toMatchObject({ strategy: "full" });
    } finally {
      if (prior === undefined) delete process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD;
      else process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD = prior;
    }
  });

  // Explicit `files: [...]` requests never reach this check at all -- resolveSelection's explicit
  // branch (src/orchestrator/index.ts) returns before ever calling SelectionEngine.plan().
  it("does not escalate the 'only test files changed' branch even when it would be over threshold", () => {
    const plan = SelectionEngine.plan({
      changedFiles: ["a.test.ts", "b.test.ts"],
      // If checked here, 2/1 would be 200% -- nowhere near escalatable; it must not be checked at all.
      totalTestFileCount: 1,
    });
    expect(plan).toMatchObject({ strategy: "incremental", reason: "only test files changed" });
    if (plan.strategy === "incremental") expect(plan.relatedFiles).toEqual(["a.test.ts", "b.test.ts"]);
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
      const plan = SelectionEngine.plan({ changedFiles: ["a.ts"], totalTestFileCount: 4 });
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
        const plan = SelectionEngine.plan({ changedFiles: ["a.ts"], totalTestFileCount: 4 });
        expect(plan).toMatchObject({ strategy: "incremental" });
      }
    } finally {
      if (prior === undefined) delete process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD;
      else process.env.TEST_MCP_INCREMENTAL_FULL_THRESHOLD = prior;
    }
  });

  // Found via adversarial review: the related list can exceed totalTestFileCount (e.g. several
  // just-added test files alongside a source change) -- the reported percentage must be capped,
  // not read as a nonsensical "150% of the suite."
  it("caps the reported percentage at 100% when the related list exceeds the known total", () => {
    const changed = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    const plan = SelectionEngine.plan({ changedFiles: changed, totalTestFileCount: 4 });
    expect(plan).toMatchObject({ strategy: "full" });
    expect(plan.reason).toContain("100%");
    expect(plan.reason).toContain("6/4 known test files");
    expect(plan.reason).not.toContain("150%");
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
