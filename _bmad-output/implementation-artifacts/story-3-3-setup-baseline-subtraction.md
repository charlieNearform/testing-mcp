# Story 3.3: Setup-Baseline Subtraction

Status: ready-for-dev

**Prerequisite:** Story 3.2 (`done`) shipped the Coverage Engine (`src/coverage/index.ts`) and the
worker's coverage build. This story extends BOTH. Read `src/coverage/index.ts` and the coverage path in
`src/worker/index.ts` first — you are modifying existing code, not starting fresh.

<!-- Implemented by a local model. Instructions are literal and copy-paste ready ON PURPOSE. Follow them
     exactly; do not infer or add scope. Read CLAUDE.md first — especially "Dependencies & install config
     (do NOT touch...)". This story adds NO dependencies (@vitest/coverage-v8 is already installed). -->

## Story

As an AI agent,
I want setup-file pollution removed from the map,
so that common modules don't make every source look globally depended-on.

## Why this matters (spike evidence)

`vitest.setup.ts` runs before EVERY test, so its transitive imports get attributed to every test file.
In the coverage spike, ~8–9 setup-induced modules (e.g. `i18n.ts`, `utils.ts`) appeared in ≥80% of
tests; editing one would re-run the WHOLE suite — defeating the product. Subtracting a measured
setup-only baseline dropped incremental selection from "whole suite" to ~6% (unit) / ~18% (integration).
[Source: docs/coverage-spike-findings.md §3]

## Acceptance Criteria

1. **Baseline measured once and subtracted.** When the coverage map is built, a **setup-only baseline**
   (the source files reached purely by `setupFiles`, measured once) is subtracted from every test file's
   attribution, so setup-induced modules are NOT recorded as per-test edges. (epics §3.3 AC1)
2. **Baseline modules are full-suite triggers.** A module reached only via the setup baseline is recorded
   as a **full-suite trigger** (a separate list on the map), not a per-test edge — so a later change to it
   selects the whole suite rather than nothing. (epics §3.3 AC2). *Consuming that list to actually pick the
   full suite is Story 3.5; here you only record it.*

## Toolchain (from docs/project-context.md and CLAUDE.md — MUST follow)

- **pnpm only.** `pnpm run typecheck`, `pnpm run build`, `pnpm test`. **Do NOT touch** `package.json`
  deps, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.json`, or the repo `vitest.config.ts`.
- **ESM + NodeNext:** `.js` extensions on relative imports in `src/**`; `.ts` on relative imports in tests.
- `strict` TS with `noUnusedLocals`/`noUnusedParameters` ON.

## Scope boundaries (do NOT overstep)

- **Files you may create/modify — and ONLY these:**
  - `src/coverage/index.ts` — schema bump, `fullSuiteTriggers` field, baseline subtraction in `buildCoverageMap` (Task 1).
  - `src/worker/index.ts` — measure the setup-only baseline and pass it into `buildCoverageMap` (Task 2).
  - `test/coverage-baseline.test.ts` — new (Task 3).
- **Do NOT touch:** the orchestrator, MCP server, IPC types, CLI, daemon, or the git-selection code. No
  new dependencies. Do NOT implement selection using `fullSuiteTriggers` (that's Story 3.5).

## Current code you are extending (verified)

- `src/coverage/index.ts` exports: `COVERAGE_MAP_SCHEMA_VERSION` (currently `1`), `CoverageMapFile`
  (`{ schemaVersion, projectId, updatedAt, map }`), `CoverageMapEntry`, `MeasurementSummary`,
  `FileMeasurement`, `coverageMapPath`, `loadCoverageMap`, `saveCoverageMap`, `buildCoverageMap(input)`,
  `extractCoveredSources(coverageFinal, projectRoot, measuredTestAbs)`.
- `buildCoverageMap`'s input is `{ projectRoot, projectId, targetTestFiles, existing, measure }`; it
  clones/prunes the existing map, calls `measure(abs)` per target, and `addEdges(map, rel, m.sources, now)`.
- `src/worker/index.ts` has `measureCoverage(startVitest, projectRoot, absTestFile)` →
  `{ sources, measured }` (runs `startVitest([file], { coverage: v8, all:false, reporter:["json"], reportsDirectory })`
  and reads `coverage-final.json` via `extractCoveredSources`), `discoverTestFiles(createVitest)`, and
  `buildAndPersistCoverageMap(cwd, projectId, files)` which calls `buildCoverageMap` then `saveCoverageMap`.

## Tasks / Subtasks

### Task 1 — Baseline subtraction in the Coverage Engine (AC: 1,2)

Edit `src/coverage/index.ts`.

1. Bump the schema (the map shape is changing; old v1 maps are simply rebuilt):
   ```ts
   export const COVERAGE_MAP_SCHEMA_VERSION = 2;
   ```
2. Add the full-suite-trigger list to the persisted shape:
   ```ts
   export interface CoverageMapFile {
     schemaVersion: number;
     projectId: string;
     updatedAt: string;
     map: Record<string, CoverageMapEntry>;
     /** Source files reached only via setupFiles — a change to any selects the whole suite (Story 3.5). */
     fullSuiteTriggers: string[];
   }
   ```
3. Add `baseline` to `BuildInput`:
   ```ts
   export interface BuildInput {
     projectRoot: string;
     projectId: string;
     targetTestFiles: string[];
     existing: CoverageMapFile | null;
     measure: (absTestFile: string) => Promise<FileMeasurement>;
     /** Source files (relative) reached purely by setupFiles; subtracted from every test's attribution. */
     baseline: string[];
   }
   ```
4. In `buildCoverageMap`, subtract the baseline from each measured file's sources before `addEdges`, and
   record the baseline as `fullSuiteTriggers`. Concretely:
   - Build a `Set` of baseline sources once: `const baselineSet = new Set(input.baseline);`
   - Where you currently do `addEdges(map, rel, m.sources, now);`, first filter:
     ```ts
     const attributed = m.sources.filter((s) => !baselineSet.has(s));
     addEdges(map, rel, attributed, now);
     ```
   - When incremental (`existing` provided), also drop any edges that are now baseline-only: after pruning
     the target test files, remove baseline sources from the whole map so a module promoted to the baseline
     stops appearing as a per-test edge:
     ```ts
     for (const src of input.baseline) delete map[src];
     ```
   - Set the field on the returned file:
     ```ts
     const file: CoverageMapFile = {
       schemaVersion: COVERAGE_MAP_SCHEMA_VERSION,
       projectId: input.projectId,
       updatedAt: now,
       map,
       fullSuiteTriggers: [...new Set(input.baseline)].sort(),
     };
     ```
   - Preserve existing `fullSuiteTriggers` sensibly: on an incremental build where you still measured the
     baseline, the freshly measured baseline replaces it (baseline is cheap and always measured — see Task 2).

### Task 2 — Measure the setup-only baseline in the worker (AC: 1,2)

Edit `src/worker/index.ts`.

1. Add a function that measures coverage of a NO-OP test written into the project root, so only
   `setupFiles` (and their imports) execute. Reuse `measureCoverage` — it already runs one file with V8
   coverage and returns executed sources.
   ```ts
   /** Measure the source files reached purely by setupFiles (a no-op test triggers only setup). */
   async function measureSetupBaseline(
     startVitest: VitestNode["startVitest"],
     projectRoot: string,
   ): Promise<string[]> {
     const baselineTest = path.join(projectRoot, "__test-mcp-baseline__.test.ts");
     fs.writeFileSync(baselineTest, `import { test } from "vitest";\ntest("baseline", () => {});\n`);
     try {
       const { sources, measured } = await measureCoverage(startVitest, projectRoot, baselineTest);
       return measured ? sources : [];
     } finally {
       fs.rmSync(baselineTest, { force: true });
     }
   }
   ```
   Notes:
   - The no-op file matches the project's `include` (`**/*.test.ts`) so `setupFiles` run before it.
   - `measureCoverage` already excludes the test file itself and other test files, so `sources` here are
     exactly the setup-induced source modules.
   - If the project has no `setupFiles`, `sources` is (near) empty — subtraction is then a no-op.

2. In `buildAndPersistCoverageMap`, measure the baseline once and pass it to `buildCoverageMap`:
   ```ts
   const baseline = await measureSetupBaseline(startVitest, cwd);
   const { file, summary } = await buildCoverageMap({
     projectRoot: cwd,
     projectId,
     targetTestFiles,
     existing: loadCoverageMap(cwd),
     measure: (abs) => measureCoverage(startVitest, cwd, abs),
     baseline,
   });
   ```
   (Everything else in that function is unchanged.)

### Task 3 — Test (AC: 1,2)

Create `test/coverage-baseline.test.ts`. Model it on `test/coverage-build.test.ts` (symlink
`node_modules`, `realpath` the temp dir). The project has a `setupFiles` that imports a shared module,
plus two tests that do NOT import it directly — proving the shared module lands in `fullSuiteTriggers`
and NOT in any per-test edge.

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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-baseline-")));
  fs.symlinkSync(repoNodeModules, path.join(dir, "node_modules"), "dir");
  // setupFiles imports common.ts -> it is setup-induced, must NOT become a per-test edge.
  fs.writeFileSync(
    path.join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["**/*.test.ts"], environment: "node", setupFiles: ["./setup.ts"] } });\n`,
  );
  fs.writeFileSync(path.join(dir, "common.ts"), `export const shared = () => 42;\n`);
  fs.writeFileSync(path.join(dir, "setup.ts"), `import { shared } from "./common.ts";\nshared();\n`);
  fs.writeFileSync(path.join(dir, "math.ts"), `export const add = (a: number, b: number) => a + b;\n`);
  fs.writeFileSync(path.join(dir, "other.ts"), `export const sub = (a: number, b: number) => a - b;\n`);
  fs.writeFileSync(
    path.join(dir, "math.test.ts"),
    `import { test, expect } from "vitest";\nimport { add } from "./math.ts";\ntest("add", () => expect(add(1, 2)).toBe(3));\n`,
  );
  fs.writeFileSync(
    path.join(dir, "other.test.ts"),
    `import { test, expect } from "vitest";\nimport { sub } from "./other.ts";\ntest("sub", () => expect(sub(2, 1)).toBe(1));\n`,
  );
  return dir;
}

afterEach(() => {
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

describe("setup-baseline subtraction", () => {
  it("records setup-induced modules as full-suite triggers, not per-test edges", async () => {
    proj = makeProject();
    const orch = new Orchestrator({ workerPath });

    await orch.runTests({ projectId: "base1", path: proj }, { coverage: true });

    const map = loadCoverageMap(proj);
    expect(map).not.toBeNull();
    expect(map!.schemaVersion).toBe(2);
    // common.ts is reached only via setup -> full-suite trigger, NOT a per-test edge.
    expect(map!.fullSuiteTriggers).toContain("common.ts");
    expect(map!.map["common.ts"]).toBeUndefined();
    // Real per-test edges still present.
    expect(map!.map["math.ts"].tests).toEqual(["math.test.ts"]);
    expect(map!.map["other.ts"].tests).toEqual(["other.test.ts"]);
  }, 120_000);
});
```

### Task 4 — Verify (AC: all)

- [ ] `pnpm run typecheck` → 0.
- [ ] `pnpm run build` → 0 (rebuilds `dist/worker`).
- [ ] `pnpm test` → all pass (existing suite unaffected — `coverage-build.test.ts` uses a project with no
      `setupFiles`, so its baseline is empty and its assertions hold; note existing maps become
      schemaVersion 2).
- [ ] Sanity: on a project WITH `setupFiles`, `coverage-map.json` has a non-empty `fullSuiteTriggers`
      and none of those files appear as keys in `map`.

## Dev Notes

### Why a no-op test measures the baseline
`setupFiles` run before every test file. A test file that asserts nothing still triggers the full setup
chain, so its coverage = (setup imports) ∪ (the test file itself). `measureCoverage` already excludes the
test file and other test files, so what remains is exactly the setup-induced source modules — the
baseline. Subtracting that set from every real test's attribution removes the pollution. [Source:
docs/coverage-spike-findings.md §3; docs/architecture.md#Coverage Engine]

### Full-suite triggers vs per-test edges
A setup-induced module legitimately affects every test, so the safe signal is "changing it → run
everything" (recorded in `fullSuiteTriggers`), NOT "changing it → run nothing" (which is what dropping it
with no record would mean). Recording, not consuming, is this story; Story 3.5 unions this into the
re-run decision. [Source: epics §3.3 AC2; docs/architecture.md#Invariants (5)]

### Schema bump
Adding `fullSuiteTriggers` changes the persisted shape, so bump `COVERAGE_MAP_SCHEMA_VERSION` to `2`.
`loadCoverageMap` already returns `null` for a mismatched version, so any v1 map is transparently
rebuilt on the next coverage run — no migration code needed.

### Previous story intelligence
- Coverage build, per-file measurement, discovery, and persistence already exist from Story 3.2 — reuse
  `measureCoverage`, don't reinvent it. [Story 3.2]
- Tests: fork the BUILT worker via `workerPath`; `realpath` the temp project so V8 absolute paths match
  the project root on macOS; symlink `node_modules` so Vitest + coverage-v8 resolve; `120_000` timeout.
  [Story 3.2 / 2.1]
- Do NOT touch dependencies/lockfile/config. [CLAUDE.md]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.3: Setup-Baseline Subtraction]
- [Source: docs/coverage-spike-findings.md#3. Setup-file coverage pollution]
- [Source: docs/architecture.md#Coverage Engine; #Invariants]
- [Source: src/coverage/index.ts; src/worker/index.ts (Story 3.2)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
