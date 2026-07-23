import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.js";
import { loadSnapshot, snapshotPath } from "../src/snapshot/index.js";

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

/** Commit a `.gitignore` for `.test-mcp/` and drop a coverage map so the map is "present". */
function seedCoverageMap(dir: string, map: Record<string, string[]>): void {
  fs.writeFileSync(path.join(dir, ".gitignore"), ".test-mcp/\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "ignore state dir"], { cwd: dir, env: GIT_ENV });
  const now = "2026-07-15T00:00:00.000Z";
  const file = {
    schemaVersion: 3,
    projectId: "g",
    updatedAt: now,
    map: Object.fromEntries(
      Object.entries(map).map(([s, tests]) => [s, { tests, lastMeasured: now }]),
    ),
    fullSuiteTriggers: [],
    alwaysRun: [],
  };
  fs.mkdirSync(path.join(dir, ".test-mcp"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".test-mcp", "coverage-map.json"), JSON.stringify(file, null, 2));
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("git-aware delta selection", () => {
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
    // Change a source that no test imports.
    fs.appendFileSync(path.join(proj, "unrelated.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
  }, 60_000);

  it("falls back to the full suite when the project is not a git repo", async () => {
    proj = makeProject(false);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
  }, 60_000);

  // Story 6.5: test-irrelevant changes are filtered before selection.
  it("collapses to an incremental no-op when only a non-code file changed (not full)", async () => {
    proj = makeProject(true);
    fs.writeFileSync(path.join(proj, "README.md"), "# docs only\n");

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(0);
  }, 60_000);

  it("still runs when a non-code file changes alongside a real (unmapped) source", async () => {
    proj = makeProject(true);
    fs.writeFileSync(path.join(proj, "README.md"), "# docs only\n");
    // unrelated.ts is imported by no test -> git --changed finds nothing -> full-suite fallback.
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

    // Not the incremental no-op: package.json survived filtering and drove a real run.
    expect(result.total).toBeGreaterThan(0);
  }, 60_000);

  // Story 6.6: a NEW source unknown to the map is bounded by the git static graph, not full.
  it("bounds a new untracked source + its new test via --changed (not the full suite)", async () => {
    proj = makeProject(true);
    seedCoverageMap(proj, { "math.ts": ["math.test.ts"], "other.ts": ["other.test.ts"] });
    // Add a brand-new source and its test, both untracked and unknown to the map.
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
  }, 60_000);

  // A NEW unmapped source's only named risk is a dynamic import the static graph can't see; when
  // the project has none anywhere, that caveat must not fire and confidence should be HIGH.
  it("a new untracked source is HIGH confidence when the project has no dynamic imports", async () => {
    proj = makeProject(true);
    seedCoverageMap(proj, { "math.ts": ["math.test.ts"], "other.ts": ["other.test.ts"] });
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
    expect(result.confidence?.level).toBe("high");
    expect(result.confidence?.reasons).toEqual([]);
  }, 60_000);

  // Same scenario, but the project genuinely has a dynamic `import()` elsewhere — the caveat is
  // real here, so it must still fire and degrade the run.
  it("a new untracked source stays degraded when the project DOES use dynamic import()", async () => {
    proj = makeProject(true);
    seedCoverageMap(proj, { "math.ts": ["math.test.ts"], "other.ts": ["other.test.ts"] });
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
    expect(result.confidence?.reasons.join(" ")).toContain("dynamic imports may be missed");
  }, 60_000);

  // Story 6.6/6.8: a MODIFIED unmapped source is bounded by --changed, not forced full by the
  // plan. Here `unrelated.ts` is imported by NO test, so the worker's --changed pass finds nothing
  // and falls back to the full suite (no silent skip) — the run reports full for that reason.
  it("runs the full suite when a modified tracked unmapped source has no importing test", async () => {
    proj = makeProject(true);
    seedCoverageMap(proj, { "math.ts": ["math.test.ts"], "other.ts": ["other.test.ts"] });
    fs.appendFileSync(path.join(proj, "unrelated.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    // Execution-time --changed fallback ran everything -> full, and a full run IS complete -> high.
    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
    expect(result.confidence?.level).toBe("high");
  }, 60_000);

  // Story 6.8: the union branch must not silently report "0 tests" when BOTH signals select
  // nothing runnable for a real change — it falls back to the full suite (closes the 6.6 gap).
  it("union branch falls back to full when the merged selection matches no test file", async () => {
    proj = makeProject(true);
    // Map a source to a test file that does not exist; the source itself is imported by no test,
    // so the coverage-map filter matches nothing AND --changed finds nothing -> merged is empty.
    seedCoverageMap(proj, { "unrelated.ts": ["ghost.test.ts"] });
    fs.appendFileSync(path.join(proj, "unrelated.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("full");
    expect(result.total).toBe(2);
    expect(result.confidence?.level).toBe("high");
  }, 60_000);

  // Story 6.8: a MODIFIED unmapped source that an existing test DOES statically import is bounded
  // (not full) and flagged degraded, so the agent knows to run a full pass.
  it("bounds a modified unmapped source via --changed and flags degraded confidence", async () => {
    proj = makeProject(true);
    // `math.ts` is imported by math.test.ts but deliberately LEFT OUT of the map, so it is a
    // modified-unmapped source with a real static importer.
    seedCoverageMap(proj, { "other.ts": ["other.test.ts"] });
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    // Bounded to the statically-affected test, NOT the full suite.
    expect(result.selection.strategy).toBe("incremental");
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);
    expect(result.selection.files.some((f) => f.includes("other.test.ts"))).toBe(false);
    // Flagged so the agent runs a full pass before calling the feature done.
    expect(result.confidence?.level).toBe("degraded");
    expect(result.confidence?.reasons.join(" ")).toContain("math.ts");
  }, 60_000);

  // Story 6.8: a degraded run must NOT advance the last-run snapshot — otherwise its
  // incompletely-covered files would drop out of future deltas (a cross-run silent skip).
  it("a degraded (bounded) run leaves the last-run snapshot unadvanced", async () => {
    proj = makeProject(true);
    seedCoverageMap(proj, { "other.ts": ["other.test.ts"] }); // math.ts deliberately unmapped
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    expect(loadSnapshot(proj)).toBeNull();
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.success).toBe(true);
    expect(result.confidence?.level).toBe("degraded");
    // No snapshot written -> math.ts stays in the next delta until a high (mapped/full) run.
    expect(loadSnapshot(proj)).toBeNull();
  }, 60_000);

  // Story 6.8: the dry-run plan preview carries the confidence verdict too.
  it("dry-run plan surfaces the confidence verdict", () => {
    proj = makeProject(true);
    seedCoverageMap(proj, { "other.ts": ["other.test.ts"] });
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    const orch = new Orchestrator({ workerPath });
    const plan = orch.plan({ projectId: "g", path: proj }, { mode: "incremental" });
    expect(plan.confidence?.level).toBe("degraded");
    expect(plan.confidence?.reasons.join(" ")).toContain("math.ts");
  });
});

// Story 6.7: the "changed since last run" incremental baseline (content-hash snapshot).
describe("changed-since-last-run baseline", () => {
  const mapForProj = { "math.ts": ["math.test.ts"], "other.ts": ["other.test.ts"] };

  it("first run (no snapshot) falls back to HEAD and writes a snapshot afterward", async () => {
    proj = makeProject(true);
    seedCoverageMap(proj, mapForProj);
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);

    expect(loadSnapshot(proj)).toBeNull();
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    // HEAD fallback + map -> only math.test.ts ran.
    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(1);
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);

    // Snapshot now exists and captured the edited math.ts content.
    const snap = loadSnapshot(proj);
    expect(snap).not.toBeNull();
    expect(snap!.files["math.ts"]).toBeDefined();
  }, 60_000);

  it("a stale unmapped edit no longer forces a full suite (snapshot baseline, not HEAD)", async () => {
    proj = makeProject(true);
    seedCoverageMap(proj, mapForProj);

    const orch = new Orchestrator({ workerPath });
    // Run 1: touch an unmapped tracked source. A HEAD baseline (and the existing 6.6 test) forces
    // the FULL suite here; that run succeeds, so the snapshot advances to include the edited file.
    fs.appendFileSync(path.join(proj, "unrelated.ts"), `// touched\n`);
    const first = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });
    expect(first.selection.strategy).toBe("full");
    expect(first.total).toBe(2);

    // Run 2: edit a mapped file. unrelated.ts is STILL dirty vs HEAD (would re-force full), but it
    // matches the snapshot, so the delta is just {math.ts} -> only math.test.ts, no full suite.
    fs.appendFileSync(path.join(proj, "math.ts"), `// touched\n`);
    const result = await orch.runTests({ projectId: "g", path: proj }, { mode: "incremental" });

    expect(result.selection.strategy).toBe("incremental");
    expect(result.total).toBe(1);
    expect(result.selection.files.some((f) => f.includes("math.test.ts"))).toBe(true);
    expect(result.selection.files.some((f) => f.includes("other.test.ts"))).toBe(false);
  }, 60_000);

  it("a change reverted before the run is a no-op (hash matches the snapshot)", async () => {
    proj = makeProject(true);
    seedCoverageMap(proj, mapForProj);
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
    seedCoverageMap(proj, mapForProj);

    const orch = new Orchestrator({ workerPath });
    // Warm up the in-memory test-file inventory with a full run BEFORE introducing the failure.
    // The Selection Engine's size-based full-run escalation divides the incremental selection by
    // this project's KNOWN test-file count (Orchestrator.getTestInventoryFileCount) -- a fresh
    // Orchestrator's inventory starts at 0 and only grows as ITS OWN runs reconcile files, so
    // without this warm-up the first (1-file) incremental run below would leave the denominator
    // at exactly 1, making the retry's identical 1-file selection look like "100% of the suite"
    // and incorrectly escalate to full -- not what this test is about. coverage:false so the
    // seeded coverage map itself is left untouched.
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
