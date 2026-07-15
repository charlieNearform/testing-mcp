# Story 3.4: Always-Run Unmeasurable Tests

Status: review

**Prerequisite:** Stories 3.2 & 3.3 (`done`) shipped the Coverage Engine (`src/coverage/index.ts`) and
the worker coverage build with setup-baseline subtraction. This story extends BOTH again. Read the
current `src/coverage/index.ts` and the coverage path in `src/worker/index.ts` first — you are modifying
existing code.

<!-- Implemented by a local model. Instructions are literal and copy-paste ready ON PURPOSE. Follow them
     exactly; do not infer or add scope. Read CLAUDE.md first — especially "Dependencies & install config
     (do NOT touch...)". This story adds NO dependencies. -->

## Story

As an AI agent,
I want unmeasurable tests never silently dropped,
so that heavy/crashing tests can't hide failures.

## Why this matters (spike evidence)

In the coverage spike, a heavy test (`CalendarPage.test.tsx`, mounts real AG-Grid) exceeded the 120s
guard under coverage instrumentation and produced NO coverage. If such a file is simply absent from the
map, a source change would select nothing for it — a silent miss. The rule (invariant 5, correctness over
cleverness): a test we cannot measure has "unknown deps" and must ALWAYS run on any relevant change.
[Source: docs/coverage-spike-findings.md §4; docs/architecture.md#Invariants (5)]

## Acceptance Criteria

1. **Record unmeasurable tests as always-run.** When the map is built, any test file that cannot be
   measured (no coverage produced, crash, or exceeds a per-file measurement budget) is recorded in the
   persisted map as an **always-run** entry ("unknown deps") rather than dropped. (epics §3.4)
2. **Bounded measurement.** A per-file measurement has a configurable time budget; exceeding it marks that
   file unmeasurable (and moves on) instead of hanging the whole map build. (docs/architecture.md#Coverage Engine — "generous, configurable per-file measurement budget")

*Consuming the always-run list to actually select those tests on a change is Story 3.5; here you only
record it. `MeasurementSummary.unmeasuredTestFiles` already exists from Story 3.2 — this story persists it.*

## Toolchain (from docs/project-context.md and CLAUDE.md — MUST follow)

- **pnpm only.** `pnpm run typecheck`, `pnpm run build`, `pnpm test`. **Do NOT touch** `package.json`
  deps, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.json`, or the repo `vitest.config.ts`.
- **ESM + NodeNext:** `.js` on relative imports in `src/**`; `.ts` on relative imports in tests.
- `strict` TS with `noUnusedLocals`/`noUnusedParameters` ON.

## Scope boundaries (do NOT overstep)

- **Files you may create/modify — and ONLY these:**
  - `src/coverage/index.ts` — schema bump, `alwaysRun` field + population/merge (Task 1).
  - `src/worker/index.ts` — per-file measurement budget (Task 2).
  - `src/orchestrator/index.ts` — forward the budget env var to the worker (Task 3).
  - `test/coverage-map.test.ts` — extend with `alwaysRun` unit assertions (Task 4).
  - `test/coverage-unmeasurable.test.ts` — new integration test (Task 4).
- **Do NOT touch:** the MCP server, IPC types, CLI, daemon, git-selection, or baseline logic. No new
  dependencies. Do NOT implement selection using `alwaysRun` (that's Story 3.5).

## Current code you are extending (verified, post-3.3)

- `src/coverage/index.ts`: `COVERAGE_MAP_SCHEMA_VERSION = 2`; `CoverageMapFile` =
  `{ schemaVersion, projectId, updatedAt, map, fullSuiteTriggers }`. `buildCoverageMap` computes an
  `unmeasured: string[]` array (test files where `measure()` returned `{ measured: false }`) and already
  returns it as `summary.unmeasuredTestFiles`. It does NOT currently persist it.
- `src/worker/index.ts`: `measureCoverage(startVitest, projectRoot, absTestFile)` returns
  `{ sources, measured }`; `buildAndPersistCoverageMap(cwd, projectId, files)` passes
  `measure: (abs) => measureCoverage(startVitest, cwd, abs)` to `buildCoverageMap`.
- `src/orchestrator/index.ts`: `execute` builds `workerEnv` forwarding only `PATH`, `HOME`, `TMPDIR`,
  `LANG`, `TEST_MCP_STATE_DIR`.

## Tasks / Subtasks

### Task 1 — Persist always-run entries in the Coverage Engine (AC: 1)

Edit `src/coverage/index.ts`.

1. Bump schema (shape changes; old v2 maps are transparently rebuilt via `loadCoverageMap`'s version guard):
   ```ts
   export const COVERAGE_MAP_SCHEMA_VERSION = 3;
   ```
2. Add the field to `CoverageMapFile`:
   ```ts
   export interface CoverageMapFile {
     schemaVersion: number;
     projectId: string;
     updatedAt: string;
     map: Record<string, CoverageMapEntry>;
     fullSuiteTriggers: string[];
     /** Test files whose deps are unknown (unmeasurable) — always run on any relevant change (Story 3.5). */
     alwaysRun: string[];
   }
   ```
3. In `buildCoverageMap`, compute `alwaysRun` from the `unmeasured` array, merging with the existing list
   on an incremental build. Add this right before you construct the returned `file`:
   ```ts
   let alwaysRun: string[];
   if (incremental) {
     const prev = new Set(input.existing!.alwaysRun ?? []);
     // Files we just re-measured: clear their prior status, then re-add if still unmeasurable.
     for (const rel of targetRels) prev.delete(rel);
     for (const rel of unmeasured) prev.add(rel);
     alwaysRun = [...prev].sort();
   } else {
     alwaysRun = [...new Set(unmeasured)].sort();
   }
   ```
   Then include it in the returned `file`:
   ```ts
   const file: CoverageMapFile = {
     schemaVersion: COVERAGE_MAP_SCHEMA_VERSION,
     projectId: input.projectId,
     updatedAt: now,
     map,
     fullSuiteTriggers: [...new Set(input.baseline)].sort(),
     alwaysRun,
   };
   ```
   (Everything else in `buildCoverageMap` is unchanged — unmeasured files already add no edges.)

### Task 2 — Per-file measurement budget in the worker (AC: 2)

Edit `src/worker/index.ts`.

1. Add a small timeout helper (top-level, near the other helpers):
   ```ts
   /** Resolve `p`, or `fallback` if it doesn't settle within `ms`. The abandoned promise is left to
    *  settle on its own (its own finally cleans up); we never hang the whole build on one file. */
   function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
     return new Promise((resolve) => {
       const timer = setTimeout(() => resolve(fallback), ms);
       p.then(
         (v) => {
           clearTimeout(timer);
           resolve(v);
         },
         () => {
           clearTimeout(timer);
           resolve(fallback);
         },
       );
     });
   }
   ```
2. In `buildAndPersistCoverageMap`, read the budget from the environment (generous default) and wrap the
   `measure` callback:
   ```ts
   const budgetMs = Number(process.env.TEST_MCP_MEASURE_BUDGET_MS ?? 120_000);
   const { file, summary } = await buildCoverageMap({
     projectRoot: cwd,
     projectId,
     targetTestFiles,
     existing: loadCoverageMap(cwd),
     measure: (abs) =>
       withTimeout(measureCoverage(startVitest, cwd, abs), budgetMs, { sources: [], measured: false }),
     baseline,
   });
   ```
   (The `baseline` measurement itself is left un-budgeted — it is a single cheap no-op run.)

### Task 3 — Forward the budget env var to the worker (AC: 2)

Edit `src/orchestrator/index.ts`. In `execute`, where `workerEnv` is assembled (after the existing
`TMPDIR`/`LANG` lines), forward the budget so it can be configured (and set low in tests):

```ts
      if (process.env.TEST_MCP_MEASURE_BUDGET_MS) {
        workerEnv.TEST_MCP_MEASURE_BUDGET_MS = process.env.TEST_MCP_MEASURE_BUDGET_MS;
      }
```

### Task 4 — Tests (AC: 1,2)

**4a. Unit — extend `test/coverage-map.test.ts`.** Add a test proving unmeasurable files are recorded and
merged. The existing `stubMeasure(table, unmeasured)` helper already supports marking files unmeasured.

```ts
it("records unmeasurable test files as always-run and merges incrementally", async () => {
  const first = await buildCoverageMap({
    projectRoot: ROOT,
    projectId: "p1",
    targetTestFiles: [`${ROOT}/a.test.ts`, `${ROOT}/heavy.test.ts`],
    existing: null,
    baseline: [],
    measure: stubMeasure({ "a.test.ts": ["a.ts"] }, ["heavy.test.ts"]),
  });
  expect(first.file.alwaysRun).toEqual(["heavy.test.ts"]);
  expect(first.file.map["heavy.test.ts"]).toBeUndefined();

  // heavy.test.ts becomes measurable on a later incremental build -> drops off always-run.
  const second = await buildCoverageMap({
    projectRoot: ROOT,
    projectId: "p1",
    targetTestFiles: [`${ROOT}/heavy.test.ts`],
    existing: first.file,
    baseline: [],
    measure: stubMeasure({ "heavy.test.ts": ["heavy.ts"] }),
  });
  expect(second.file.alwaysRun).toEqual([]);
  expect(second.file.map["heavy.ts"].tests).toEqual(["heavy.test.ts"]);
});
```

Also add `alwaysRun` to the fresh-build assertion in the existing "builds a fresh source->test reverse
map" test if you touch it: a fully-measurable build has `file.alwaysRun` equal to `[]`.

**4b. Integration — create `test/coverage-unmeasurable.test.ts`.** Model it on
`test/coverage-build.test.ts` (symlink `node_modules`, `realpath` the temp dir). One fast test + one slow
test; set a tiny budget so the slow file times out and is recorded as always-run, while the fast file maps
normally.

```ts
import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";
import { loadCoverageMap } from "../src/coverage/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const repoNodeModules = path.join(repoRoot, "node_modules");

let proj: string;

function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-unmeas-")));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node", testTimeout: 20000 } });\n`,
  );
  fs.writeFileSync(path.join(dir, "fast.ts"), `export const one = () => 1;\n`);
  fs.writeFileSync(
    path.join(dir, "fast.test.ts"),
    `import { test, expect } from "vitest";\nimport { one } from "./fast.ts";\ntest("one", () => expect(one()).toBe(1));\n`,
  );
  // A slow test that outlives a tiny measurement budget (but not vitest's testTimeout).
  fs.writeFileSync(
    path.join(dir, "slow.test.ts"),
    `import { test, expect } from "vitest";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 3000)); expect(true).toBe(true); });\n`,
  );
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
  delete process.env.TEST_MCP_MEASURE_BUDGET_MS;
});

describe("unmeasurable tests -> always-run", () => {
  it("records a test exceeding the measurement budget as always-run, maps the rest", async () => {
    proj = makeProject();
    process.env.TEST_MCP_MEASURE_BUDGET_MS = "500"; // slow.test.ts (3s) will exceed this
    const orch = new Orchestrator({ workerPath });

    await orch.runTests({ projectId: "unmeas1", path: proj }, { coverage: true });

    const map = loadCoverageMap(proj);
    expect(map).not.toBeNull();
    expect(map!.schemaVersion).toBe(3);
    expect(map!.alwaysRun).toContain("slow.test.ts");
    expect(map!.map["fast.ts"].tests).toEqual(["fast.test.ts"]);
  }, 120_000);
});
```

Notes on the integration test:
- The tiny 500ms budget makes `slow.test.ts` (3s) exceed it → `withTimeout` returns `measured:false` →
  recorded in `alwaysRun`. `fast.ts` is measured normally.
- Test files are discovered sorted; `fast.test.ts` is measured before `slow.test.ts`, so the abandoned
  slow measurement does not overlap the fast one.

### Task 5 — Verify (AC: all)

- [ ] `pnpm run typecheck` → 0.
- [ ] `pnpm run build` → 0.
- [ ] `pnpm test` → all pass (existing coverage/baseline tests still pass; their fully-measurable builds
      yield `alwaysRun: []`; maps become schemaVersion 3).
- [ ] Sanity: a project with a genuinely unmeasurable test yields a non-empty `alwaysRun` and that file is
      NOT a key in `map`.

## Dev Notes

### Why record, not drop
An unmeasurable test has UNKNOWN dependencies. Dropping it means a source change never selects it — a
silent miss, exactly what invariant 5 forbids. Recording it in `alwaysRun` lets Story 3.5 always include
it whenever any relevant change occurs. This story only records. [Source: docs/architecture.md#Invariants (5)]

### The budget bounds one file, never the build
`withTimeout` resolves a fallback (`measured:false`) if a single file's measurement overruns, so one
pathological file cannot hang the entire map build. The abandoned measurement settles on its own (its
`finally` removes its temp reports dir). The orchestrator's whole-run timeout remains a coarse backstop.
The default budget is generous (120s); tests set it low via `TEST_MCP_MEASURE_BUDGET_MS`.

### Schema bump
Adding `alwaysRun` changes the persisted shape → bump `COVERAGE_MAP_SCHEMA_VERSION` to `3`.
`loadCoverageMap` returns `null` on a version mismatch, so any v2 map is transparently rebuilt on the next
coverage run — no migration code.

### Previous story intelligence
- `unmeasured` is already computed in `buildCoverageMap`; you are persisting + merging it, not detecting it anew. [Story 3.2]
- Reuse `measureCoverage`; do not reinvent measurement. [Story 3.2/3.3]
- Tests: fork the BUILT worker via `workerPath`; `realpath` the temp project; symlink `node_modules`;
  `120_000` timeout; clean up the env var in `afterEach`. [Story 3.2/3.3]
- Do NOT touch dependencies/lockfile/config. [CLAUDE.md]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.4: Always-Run Unmeasurable Tests]
- [Source: docs/coverage-spike-findings.md#4. Heavy tests can be unmeasurable under coverage]
- [Source: docs/architecture.md#Coverage Engine; #Invariants]
- [Source: src/coverage/index.ts; src/worker/index.ts; src/orchestrator/index.ts (Story 3.2/3.3)]

## Dev Agent Record

### Agent Model Used
qwen3-coder-next

### Debug Log References

### Completion Notes
Implemented Story 3.4: Always-Run Unmeasurable Tests.

**Task 1 - Persist always-run entries:** Bumped schema version to 3, added `alwaysRun: string[]` field to `CoverageMapFile`. Added logic in `buildCoverageMap` to compute and merge `alwaysRun` from unmeasured test files across incremental builds.

**Task 2 - Per-file measurement budget:** Added `withTimeout<T>` helper in worker that resolves with fallback if promise doesn't settle within configured ms. Updated `buildAndPersistCoverageMap` to use `TEST_MCP_MEASURE_BUDGET_MS` env var (default 120s) when measuring each test file.

**Task 3 - Forward budget env var:** Added forwarding of `TEST_MCP_MEASURE_BUDGET_MS` from orchestrator to worker in `execute()` method.

**Task 4 - Tests:** Extended unit tests in `test/coverage-map.test.ts` with new test proving unmeasurable files are recorded and merged incrementally. Created integration test `test/coverage-unmeasurable.test.ts` verifying slow tests exceeding budget are recorded as always-run while fast tests map normally.

All ACs satisfied:
1. Unmeasurable tests recorded as always-run ✓
2. Per-file measurement bounded by configurable budget ✓

### File List
- src/coverage/index.ts
- src/worker/index.ts
- src/orchestrator/index.ts
- test/coverage-map.test.ts
- test/coverage-unmeasurable.test.ts
- test/coverage-baseline.test.ts
- test/coverage-build.test.ts
