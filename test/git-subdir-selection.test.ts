import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getChangedFiles } from "../src/selection/index.ts";
import { listCandidateFiles } from "../src/snapshot/index.ts";

/**
 * Regression coverage for a project registered at a repo SUBDIRECTORY (e.g. `frontend/`).
 * Git emits repo-root-relative paths for the whole repo; these must be mapped to project-relative
 * paths (no `frontend/frontend/…`, no false deletions) and out-of-project changes handled per the
 * escalate-or-drop policy. The existing `git-selection.test.ts` only covers projectRoot === gitRoot.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let gitRoot: string;

/** A git repo whose registered project lives in `frontend/`, alongside a sibling `backend/`. */
function makeSubdirRepo(): { gitRoot: string; projectRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-subdir-"));
  fs.mkdirSync(path.join(root, "frontend", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "backend"), { recursive: true });
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "frontend", "other.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(root, "backend", "b.ts"), "export const c = 3;\n");
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, env: GIT_ENV });
  return { gitRoot: root, projectRoot: path.join(root, "frontend") };
}

afterEach(() => {
  if (gitRoot) fs.rmSync(gitRoot, { recursive: true, force: true });
});

describe("getChangedFiles for a subdir-registered project", () => {
  it("maps an in-project change to a project-relative path (no frontend/frontend, no false deletion)", () => {
    const { gitRoot: g, projectRoot } = makeSubdirRepo();
    gitRoot = g;
    fs.appendFileSync(path.join(projectRoot, "src", "a.ts"), "// touched\n");

    const changed = getChangedFiles(projectRoot);
    expect(changed).not.toBeNull();
    expect(changed!.files).toContain("src/a.ts");
    expect(changed!.files.some((f) => f.startsWith("frontend/"))).toBe(false);
    // The mapped path must resolve on disk — the exact check the orchestrator uses to detect
    // (false) deletions that previously forced a full-suite fallback.
    expect(fs.existsSync(path.resolve(projectRoot, changed!.files[0]))).toBe(true);
  });

  it("escalates to the full suite (null) when a relevant out-of-project path changed", () => {
    const { gitRoot: g, projectRoot } = makeSubdirRepo();
    gitRoot = g;
    fs.appendFileSync(path.join(g, "backend", "b.ts"), "// touched\n");

    expect(getChangedFiles(projectRoot)).toBeNull();
  });

  it("escalates even when an in-project change accompanies a relevant out-of-project change", () => {
    const { gitRoot: g, projectRoot } = makeSubdirRepo();
    gitRoot = g;
    fs.appendFileSync(path.join(projectRoot, "src", "a.ts"), "// touched\n");
    fs.appendFileSync(path.join(g, "backend", "b.ts"), "// touched\n");

    expect(getChangedFiles(projectRoot)).toBeNull();
  });

  it("drops test-irrelevant out-of-project changes without escalating", () => {
    const { gitRoot: g, projectRoot } = makeSubdirRepo();
    gitRoot = g;
    fs.appendFileSync(path.join(g, ".github", "workflows", "ci.yml"), "# touched\n");
    fs.appendFileSync(path.join(g, "README.md"), "touched\n");

    const changed = getChangedFiles(projectRoot);
    expect(changed).not.toBeNull();
    expect(changed!.files).toEqual([]);
  });

  it("returns null when the project is not in a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-nogit-"));
    try {
      expect(getChangedFiles(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listCandidateFiles for a subdir-registered project", () => {
  it("returns only project files, project-relative, excluding siblings", () => {
    const { gitRoot: g, projectRoot } = makeSubdirRepo();
    gitRoot = g;

    const candidates = listCandidateFiles(projectRoot);
    expect(candidates).not.toBeNull();
    expect(candidates).toContain("src/a.ts");
    expect(candidates).toContain("other.ts");
    expect(candidates!.some((f) => f.startsWith("frontend/"))).toBe(false);
    expect(candidates!.some((f) => f.startsWith("backend/"))).toBe(false);
  });
});
