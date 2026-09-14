import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { splitRepoPathsByProject, toProjectRelativePath } from "../src/git/paths.ts";

describe("toProjectRelativePath", () => {
  const gitRoot = "/repo";
  const projectRoot = path.join(gitRoot, "frontend");

  it("maps a repo path under the project to a project-relative path", () => {
    expect(toProjectRelativePath(projectRoot, gitRoot, "frontend/src/a.ts")).toBe("src/a.ts");
  });

  it("returns null for paths outside the project directory", () => {
    expect(toProjectRelativePath(projectRoot, gitRoot, ".github/workflows/ci.yml")).toBeNull();
  });

  it("passes through when project root is the git root", () => {
    expect(toProjectRelativePath(gitRoot, gitRoot, "frontend/src/a.ts")).toBe("frontend/src/a.ts");
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    // `frontend-e2e` shares the `frontend` prefix but is a different directory.
    expect(toProjectRelativePath(projectRoot, gitRoot, "frontend-e2e/spec.ts")).toBeNull();
  });
});

describe("splitRepoPathsByProject", () => {
  const gitRoot = "/repo";
  const projectRoot = path.join(gitRoot, "frontend");

  it("partitions inside (mapped) from outside (unmapped) paths for a subdir project", () => {
    const { inside, outside } = splitRepoPathsByProject(projectRoot, gitRoot, [
      "frontend/src/a.ts",
      "frontend/src/b.ts",
      "backend/server.ts",
      ".github/workflows/ci.yml",
    ]);
    expect(inside).toEqual(["src/a.ts", "src/b.ts"]);
    expect(outside).toEqual(["backend/server.ts", ".github/workflows/ci.yml"]);
  });

  it("treats every path as inside (passthrough) when project root is the git root", () => {
    const { inside, outside } = splitRepoPathsByProject(gitRoot, gitRoot, ["src/a.ts", "b.ts"]);
    expect(inside).toEqual(["src/a.ts", "b.ts"]);
    expect(outside).toEqual([]);
  });

  it("treats every path as inside (passthrough) when git is unavailable", () => {
    const { inside, outside } = splitRepoPathsByProject(projectRoot, null, ["frontend/src/a.ts"]);
    expect(inside).toEqual(["frontend/src/a.ts"]);
    expect(outside).toEqual([]);
  });

  it("returns empty partitions for empty input", () => {
    expect(splitRepoPathsByProject(projectRoot, gitRoot, [])).toEqual({ inside: [], outside: [] });
  });
});
