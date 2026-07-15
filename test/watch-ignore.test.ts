import { describe, it, expect } from "vitest";
import { isIgnoredWatchPath } from "../src/watch/index.ts";

describe("isIgnoredWatchPath", () => {
  it("ignores changes inside ignored directories", () => {
    expect(isIgnoredWatchPath("node_modules/foo/index.js")).toBe(true);
    expect(isIgnoredWatchPath(".git/HEAD")).toBe(true);
    expect(isIgnoredWatchPath(".test-mcp/coverage-map.json")).toBe(true);
    expect(isIgnoredWatchPath("dist/index.js")).toBe(true);
  });

  it("ignores the transient coverage baseline file (prevents the watch self-loop)", () => {
    expect(isIgnoredWatchPath("__test-mcp-baseline__.test.ts")).toBe(true);
    expect(isIgnoredWatchPath("src/__test-mcp-baseline__.test.ts")).toBe(true);
  });

  it("does not ignore real source/test changes", () => {
    expect(isIgnoredWatchPath("src/foo.ts")).toBe(false);
    expect(isIgnoredWatchPath("test/foo.test.ts")).toBe(false);
  });
});
