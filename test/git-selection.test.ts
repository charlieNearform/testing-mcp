import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.js";
import { loadSnapshot, snapshotPath } from "../src/snapshot/index.js";

/**
 * Story 3.8 rewrite: the reverse coverage map is gone. Selection is now uniformly
 * `related`-based -- the since-last-run changed-file delta is fed straight into Vitest's
 * `related` config field, which resolves affected tests via the static import graph.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const repoNodeModules = path.join(repoRoot, "node_modules");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let proj: string;

/** Create a small project (Vitest resolvable via a node_modules symlink); optionally a git repo. */
function makeProject(withGit: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-gitsel-"));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node" } });\n`,
  );
  fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
  fs.writeFileSync(path.join(dir, "other.ts"), `export const sub = (a: number, b: number) => a - b;\n`);
  fs.writeFileSync(path.join(dir, "unrelated.ts"), `export const orphan = 1;\n`);
  fs.writeFileSync(
    path.join(dir, "math.test.ts"),
    `import { test, expect } from "vitest";\nimport { add } from "./math.ts";\ntest("add", () => expect(add(1, 2)).toBe(3));\n`,
  );
  fs.writeFileSync(
    path.join(dir, "other.test.ts"),
    `import { test, expect } from "vitest";\nimport { sub } from "./other.ts";\ntest("sub", () => expect(sub(2, 1)).toBe(1));\n`,
  );
  if (withGit) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });
  }
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("related-based delta selection (Story 3.8)", () => {
  it("incremental runs only the test files affected by the git diff", async () => {
    proj = makeProject(true);
    // Modify a source imported by exactly one test.
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(1);
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);
    expect(result.selection.files.some((f) => f.includes("other.test.ts"))).toBe(false);
  }, 60_000);

  it("falls back to the full suite when the change maps to no test (no silent skip)", async () => {
    proj = makeProject(true);
    // Change a source that no test imports -- a genuine orphan, confirmed live to resolve to
    // zero matches via `related` (Dev Notes finding b).
    fs.appendFileSync(path.join(proj, "unrelated.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
    expect(result.confidence?.level).toBe("high");
  }, 60_000);

  it("falls back to the full suite when the project is not a git repo", async () => {
    proj = makeProject(false);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
  }, 60_000);

  // Patch C: a deletion alongside another change must NOT silently skip the deletion-broken test.
  // `related = [deleted math.ts, modified other.ts]` would select only other.test.ts; math.test.ts
  // (imports the now-deleted math.ts, therefore broken) would never run. Escalate to full instead.
  it("escalates to a full run when a changed path was deleted from disk (no silent skip of a broken importer)", async () => {
    proj = makeProject(true);
    fs.rmSync(path.join(proj, "math.ts")); // a source that math.test.ts imports
    fs.appendFileSync(path.join(proj, "other.ts"), `// touched\n`); // a still-present change

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests(
      { projectId: "g", path: proj },
      { mode: "incremental", coverage: false },
    );

    expect(result.selection.strategy).toBe("full");
    expect(result.selection.reason).toContain("deleted");
    // math.test.ts (broken by the deletion) was actually run, not skipped.
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);
  }, 60_000);

  // Patch D: watch calls runTests({mode:"incremental", coverage:false}); a run that falls back to
  // full (here: non-git) must still measure NO coverage, or watch would reintroduce the
  // incremental-loop coverage cost AC7 forbids.
  it("an incremental run with coverage:false yields no coverage even when it falls back to full (watch's AC7 contract)", async () => {
    proj = makeProject(false); // non-git -> selection falls back to a full suite

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests(
      { projectId: "g", path: proj },
      { mode: "incremental", coverage: false },
    );

    expect(result.selection.strategy).toBe("full");
    expect(result.coverage).toBeUndefined();
  }, 60_000);

  // Patch I: the dry-run plan must reject coverage:true on a non-full selection with the SAME
  // error the real run throws, instead of previewing success.
  it("dry-run rejects coverage:true on an incremental selection, mirroring the real run (Patch I)", () => {
    proj = makeProject(true);
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    expect(() =>
      orch.plan({ projectId: "g", path: proj }, { mode: "incremental", coverage: true }),
    ).toThrow(/full-suite/);
  });

  // Story 6.5: test-irrelevant changes are filtered before selection.
  it("collapses to an incremental no-op when only a non-code file changed (not full)", async () => {
    proj = makeProject(true);
    fs.writeFileSync(path.join(proj, "README.md"), "# docs only\n");

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(0);
  }, 60_000);

  it("still runs when a non-code file changes alongside a real (orphan) source", async () => {
    proj = makeProject(true);
    fs.writeFileSync(path.join(proj, "README.md"), "# docs only\n");
    // unrelated.ts is imported by no test -> related finds nothing -> full-suite fallback.
    fs.appendFileSync(path.join(proj, "unrelated.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
  }, 60_000);

  it("honours a project .test-mcp-ignore pattern for a non-code file (no-op)", async () => {
    proj = makeProject(true);
    // Commit the ignore file so it is not itself an outstanding change.
    fs.writeFileSync(path.join(proj, ".test-mcp-ignore"), "# custom\n*.snap\n");
    execFileSync("git", ["add", "-A"], { cwd: proj });
    execFileSync("git", ["commit", "-q", "-m", "add ignore"], { cwd: proj, env: GIT_ENV });
    fs.writeFileSync(path.join(proj, "foo.snap"), "snapshot\n");

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(0);
  }, 60_000);

  it("never filters package.json (keep-always) so it still triggers a run", async () => {
    proj = makeProject(true);
    fs.writeFileSync(path.join(proj, "package.json"), `{ "name": "tmp", "version": "0.0.0" }\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    // Not the incremental no-op: package.json survived filtering and drove a real run
    // (package.json itself is not a test file, has no static importers -> full-suite fallback).
    expect(result.total).toBeGreaterThan(0);
  }, 60_000);

  // Story 6.6/AC6: a NEW source with no dynamic imports anywhere in the project is HIGH confidence.
  it("bounds a new untracked source + its new test via related (not the full suite)", async () => {
    proj = makeProject(true);
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.mkdirSync(path.join(proj, "test"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "date.ts"), `export const iso = () => "2026-07-15";\n`);
    fs.writeFileSync(
      path.join(proj, "test", "date.test.ts"),
      `import { test, expect } from "vitest";\nimport { iso } from "../src/date.ts";\ntest("iso", () => expect(iso()).toBe("2026-07-15"));\n`,
    );

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    // Bounded, not full: only the new test ran (existing math/other tests did not).
    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(1);
    expect(result.selection.files.some((f) => f.includes("date.test.ts"))).toBe(true);
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(false);
    expect(result.selection.files.some((f) => f.includes("other.test.ts"))).toBe(false);
    expect(result.confidence?.level).toBe("high");
    expect(result.confidence?.reasons).toEqual([]);
  }, 60_000);

  // Same scenario, but the project genuinely has a dynamic `import()` elsewhere — AC6's caveat
  // is real here, so it must still fire and degrade the run.
  it("a new untracked source stays degraded when the project DOES use dynamic import()", async () => {
    proj = makeProject(true);
    fs.writeFileSync(
      path.join(proj, "loader.ts"),
      `export async function load(name: string) { return import(name); }\n`,
    );
    execFileSync("git", ["add", "-A"], { cwd: proj });
    execFileSync("git", ["commit", "-q", "-m", "add a dynamic loader"], { cwd: proj, env: GIT_ENV });
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.mkdirSync(path.join(proj, "test"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "date.ts"), `export const iso = () => "2026-07-15";\n`);
    fs.writeFileSync(
      path.join(proj, "test", "date.test.ts"),
      `import { test, expect } from "vitest";\nimport { iso } from "../src/date.ts";\ntest("iso", () => expect(iso()).toBe("2026-07-15"));\n`,
    );

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.confidence?.level).toBe("degraded");
    expect(result.confidence?.reasons.join(" ")).toContain("dynamic import");
    expect(result.confidence?.reasons.join(" ")).toContain("date.ts");
  }, 60_000);

  // Story 6.8: a degraded run must NOT advance the last-run snapshot — otherwise its
  // incompletely-covered files would drop out of future deltas (a cross-run silent skip).
  it("a degraded (bounded) run leaves the last-run snapshot unadvanced", async () => {
    proj = makeProject(true);
    fs.writeFileSync(
      path.join(proj, "loader.ts"),
      `export async function load(name: string) { return import(name); }\n`,
    );
    execFileSync("git", ["add", "-A"], { cwd: proj });
    execFileSync("git", ["commit", "-q", "-m", "add a dynamic loader"], { cwd: proj, env: GIT_ENV });

    expect(loadSnapshot(proj)).toBeNull();
    // A NEW source WITH a real static importer (unlike a genuine orphan, which would trigger the
    // empty-match full-suite fallback and force confidence back to high) -- `related` resolves it
    // to exactly its own new test, staying genuinely incremental/degraded (AC6).
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.mkdirSync(path.join(proj, "test"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "date.ts"), `export const iso = () => "2026-07-15";\n`);
    fs.writeFileSync(
      path.join(proj, "test", "date.test.ts"),
      `import { test, expect } from "vitest";\nimport { iso } from "../src/date.ts";\ntest("iso", () => expect(iso()).toBe("2026-07-15"));\n`,
    );
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.success).toBe(true);
    expect(result.confidence?.level).toBe("degraded");
    // No snapshot written -> src/date.ts stays in the next delta until a high-confidence run
    // (or full run) validates it.
    expect(loadSnapshot(proj)).toBeNull();
  }, 60_000);

  // Story 6.8: the dry-run plan preview carries the confidence verdict too.
  it("dry-run plan surfaces the confidence verdict", () => {
    proj = makeProject(true);
    fs.writeFileSync(
      path.join(proj, "loader.ts"),
      `export async function load(name: string) { return import(name); }\n`,
    );
    execFileSync("git", ["add", "-A"], { cwd: proj });
    execFileSync("git", ["commit", "-q", "-m", "add a dynamic loader"], { cwd: proj, env: GIT_ENV });
    fs.writeFileSync(path.join(proj, "mystery.ts"), `export const x = 1;\n`);

    const orch = new Orchestrator({ workerPath });
    const plan = orch.plan({ projectId: "g", path: proj }, { mode: "incremental" });
    expect(plan.confidence?.level).toBe("degraded");
    expect(plan.confidence?.reasons.join(" ")).toContain("mystery.ts");
  });
});

// Story 6.7: the "changed since last run" incremental baseline (content-hash snapshot).
describe("changed-since-last-run baseline (Story 3.8: related-based)", () => {
  it("first run (no snapshot) falls back to HEAD and writes a snapshot afterward", async () => {
    proj = makeProject(true);
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    expect(loadSnapshot(proj)).toBeNull();
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    // HEAD fallback -> related resolves only math.test.ts.
    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(1);
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);

    // Snapshot now exists and captured the edited math.ts content.
    const snap = loadSnapshot(proj);
    expect(snap).not.toBeNull();
    expect(snap!.files["math.ts"]).toBeDefined();
  }, 60_000);

  it("does not re-select an already-validated file's tests on a later run in the same uncommitted session", async () => {
    proj = makeProject(true);
    const orch = new Orchestrator({ workerPath });
    // Warm up the in-memory test-file inventory with a full run first (the size-based escalation's
    // denominator, unaffected by this story) so neither incremental run below escalates to full.
    await orch.runTests({ projectId: "g", path: proj }, { mode: "full", coverage: false });

    // Run 1: edit math.ts and run — this validates math.ts and advances the last-run snapshot past it.
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);
    const first = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });
    expect(first.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);

    // Run 2: edit other.ts too, still without committing math.ts's change. This is the EXACT
    // regression this story fixes: `changed: true` would re-select math.ts's tests again just
    // because it's still uncommitted; `related`, fed from the since-last-run snapshot delta, must
    // select ONLY other.test.ts.
    fs.appendFileSync(path.join(proj, "other.ts"), `// touched\n`);
    const second = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });
    expect(second.selection.files.some((f) => f.includes("other.test.ts"))).toBe(true);
    expect(second.selection.files.some((f) => f.includes("math.test.ts"))).toBe(false);
  }, 120_000);

  it("a change reverted before the run is a no-op (hash matches the snapshot)", async () => {
    proj = makeProject(true);
    const originalOther = fs.readFileSync(path.join(proj, "other.ts"));

    const orch = new Orchestrator({ workerPath });
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);
    await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    // Edit then revert other.ts to its snapshot content before running.
    fs.appendFileSync(path.join(proj, "other.ts"), `// touched\n`);
    fs.writeFileSync(path.join(proj, "other.ts"), originalOther);
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(0);
  }, 60_000);

  it("a failed run leaves the snapshot unchanged so the same delta re-runs", async () => {
    proj = makeProject(true);

    const orch = new Orchestrator({ workerPath });
    // Warm up the in-memory test-file inventory with a full run BEFORE introducing the failure.
    // The Selection Engine's size-based full-run escalation divides the related-file list by this
    // project's KNOWN test-file count (Orchestrator.getTestInventoryFileCount) -- a fresh
    // Orchestrator's inventory starts at 0 and only grows as ITS OWN runs reconcile files, so
    // without this warm-up the first (1-file) incremental run below would leave the denominator
    // at exactly 1, making the retry's identical 1-file selection look like "100% of the suite"
    // and incorrectly escalate to full -- not what this test is about.
    await orch.runTests({ projectId: "g", path: proj }, { mode: "full", coverage: false });

    // Break add() so math.test.ts (expects 3) fails on the delta-selected run.
    fs.writeFileSync(path.join(proj, "math.ts"), `export const add = (a: number, b: number) => a + b + 1;\n`);

    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.total).toBe(1);
    expect(result.success).toBe(false);
    // No snapshot advanced on failure -> the changed file stays in the next delta.
    expect(fs.existsSync(snapshotPath(proj))).toBe(false);

    const again = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });
    expect(again.total).toBe(1);
    expect(again.success).toBe(false);
    expect(fs.existsSync(snapshotPath(proj))).toBe(false);
  }, 60_000);
});
