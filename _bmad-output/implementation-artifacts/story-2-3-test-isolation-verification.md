# Story 2.3: Test Isolation Verification

Status: done

**Prerequisite:** Story 2.2 complete (`run_tests` + `get_failure_details`, worker/orchestrator result flow, all `done`). Build on that code in place.

<!-- Implemented by a local model (qwen3-coder-next). Instructions are literal and copy-paste ready
     ON PURPOSE. Follow them exactly; do not infer or add scope. Read CLAUDE.md first — especially
     "Dependencies & install config (do NOT touch...)". This story adds NO dependencies. If a build
     error smells dependency-related, STOP and hand back to the orchestrator; do not thrash. -->

## Story

As an AI agent,
I want per-file environment isolation,
so that cross-file state leakage doesn't produce false results.

## Acceptance Criteria

1. **Isolation gives fresh per-file context.** When a suite runs with `isolate: true` (Vitest's default), each test file executes in a fresh module/environment context, so module-level state set by one test file does not leak into another. (epics §2.3 AC1)
2. **Isolation state is surfaced.** When a project explicitly disables isolation for speed (`isolate: false`), the run `metadata` reports that isolation is off (`metadata.isolate === false`); otherwise it reports `true`. (epics §2.3 AC2)

## Toolchain (from docs/project-context.md and CLAUDE.md — MUST follow)

- **pnpm only.** `pnpm run typecheck`, `pnpm run build`, `pnpm test`. Never `npm`/`yarn`. **Do NOT touch** `package.json` deps, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.json`, or the repo's `vitest.config.ts`.
- **ESM + NodeNext:** relative imports in `src/**` use the `.js` extension in the specifier; test imports use the `.ts` extension on relative source paths.
- Node 20+, `strict` TypeScript with `noUnusedLocals`/`noUnusedParameters` ON — no unused vars/params.
- **No new dependencies.**

## Scope boundaries (do NOT overstep)

- **Files you may create/modify — and ONLY these:**
  - `src/types/contracts.ts` — add `isolate: boolean` to `TestResult.metadata` (Task 1).
  - `src/worker/index.ts` — read the resolved `isolate` from the Vitest instance and thread it into the result metadata (Task 2).
  - `test-fixtures/isolation-project/{vitest.config.ts,counter.ts,a.test.ts,b.test.ts}` — new fixture proving isolation (Task 3).
  - `test-fixtures/no-isolation-project/{vitest.config.ts,noop.test.ts}` — new fixture with isolation off (Task 3).
  - `test/isolation.test.ts` — new (Task 4).
- **Do NOT touch:** the existing `test-fixtures/sample-project/` (changing its file/test counts would break the `worker-run`/`mcp-run-tests`/`failure-details` tests), the orchestrator, the MCP server, the daemon, the CLI, `src/types/ipc.ts`, or the scaffold layout. Metadata already flows daemon→client via `TestResult`; no wiring changes are needed.
- **Not in this story:** allowing the client to *choose* isolation per run, any new tool/param, coverage, or selection. Isolation is a property of the project's own Vitest config; you only surface it.

## Verified facts to build on (current code + installed Vitest 4.1.9)

- The Vitest instance returned by `startVitest(...)` exposes `config: ResolvedConfig`, and `ResolvedConfig.isolate` is a resolved `boolean` (default `true`). (Verified against the installed `vitest` `.d.ts`.) Read it as `vitest.config.isolate`.
- `src/worker/index.ts` currently: `mapModulesToResult(modules, unhandled, wallClockMs, requestedFiles)` builds `metadata: { wallClockMs, testExecMs, overheadMs }`; `runVitest` does `const vitest = await startVitest(...)`, guards `if (!vitest) throw ...`, then returns `{ result: mapModulesToResult(...), failureDetails: mapFailureDetails(...) }` in a `try/finally` that calls `vitest.close()`. The worker's minimal `VitestNode` type declares `startVitest(...): Promise<{ close(): Promise<void> } | false>`.
- `src/types/contracts.ts` `TestResult.metadata` is optional (`metadata?`) with `wallClockMs/testExecMs/overheadMs`. `mapModulesToResult` always sets it, so in practice it is present on every run.
- Fixtures live under `test-fixtures/` (repo root), outside the parent Vitest `include` (`test/**/*.test.ts`) and outside `tsconfig`'s `src`-only compile — so new fixture files are never collected by the parent run nor type-checked by `tsc`. When the worker runs a fixture (cwd = fixture dir), it resolves the repo's installed Vitest by walking up `node_modules`.

## Tasks / Subtasks

### Task 1 — Add `isolate` to result metadata (AC: 2)

**`src/types/contracts.ts`** — add `isolate` to the `metadata` shape:

```ts
  /** Timing breakdown so daemon/worker overhead is observable (NFR7). Optional; added in Story 2.1. */
  metadata?: {
    wallClockMs: number;
    testExecMs: number;
    overheadMs: number;
    /** Resolved Vitest per-file isolation for this run (Story 2.3). */
    isolate: boolean;
  };
```

### Task 2 — Surface isolation from the worker (AC: 1,2)

Edit `src/worker/index.ts`.

1. Extend the worker's minimal Vitest typing so the instance exposes the resolved config. Replace the `VitestNode` interface with:
   ```ts
   interface VitestInstance {
     close(): Promise<void>;
     config: { isolate: boolean };
   }
   interface VitestNode {
     startVitest(
       mode: string,
       cliFilters: string[],
       options: Record<string, unknown>,
     ): Promise<VitestInstance | false>;
   }
   ```
2. Add an `isolate` parameter to `mapModulesToResult` (last param) and include it in the metadata it returns:
   ```ts
   export function mapModulesToResult(
     modules: ReadonlyArray<VTestModule>,
     unhandled: ReadonlyArray<VError>,
     wallClockMs: number,
     requestedFiles: string[],
     isolate: boolean,
   ): TestResult {
   ```
   ...and in its returned object:
   ```ts
     metadata: {
       wallClockMs,
       testExecMs,
       overheadMs: Math.max(0, wallClockMs - testExecMs),
       isolate,
     },
   ```
3. In `runVitest`, read the resolved isolation from the instance and pass it through. After the `if (!vitest) { throw ... }` guard:
   ```ts
   const isolate = vitest.config.isolate ?? true;
   try {
     return {
       result: mapModulesToResult(modules, unhandled, wallClockMs, files, isolate),
       failureDetails: mapFailureDetails(modules, unhandled),
     };
   } finally {
     await vitest.close();
   }
   ```

(No other files change — `TestResult.metadata.isolate` now rides through the existing worker→orchestrator→`run_tests` path to the client.)

### Task 3 — Fixtures (AC: 1,2)

**Isolation-on fixture** (proves fresh per-file module state). Two test files share a module with a mutable counter; under isolation each file sees a fresh copy, so both observe `1`.

`test-fixtures/isolation-project/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    environment: "node",
    // isolate defaults to true — stated explicitly for the fixture's intent.
    isolate: true,
  },
});
```

`test-fixtures/isolation-project/counter.ts`:
```ts
let count = 0;

export function increment(): number {
  count += 1;
  return count;
}
```

`test-fixtures/isolation-project/a.test.ts`:
```ts
import { test, expect } from "vitest";
import { increment } from "./counter.ts";

test("file A sees a fresh counter", () => {
  expect(increment()).toBe(1);
});
```

`test-fixtures/isolation-project/b.test.ts`:
```ts
import { test, expect } from "vitest";
import { increment } from "./counter.ts";

test("file B sees a fresh counter (no leak from file A)", () => {
  expect(increment()).toBe(1);
});
```

**Isolation-off fixture** (surfaces `metadata.isolate === false`).

`test-fixtures/no-isolation-project/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    environment: "node",
    isolate: false,
  },
});
```

`test-fixtures/no-isolation-project/noop.test.ts`:
```ts
import { test, expect } from "vitest";

test("trivial pass", () => {
  expect(true).toBe(true);
});
```

> Note the fixture test files import `./counter.ts` with the `.ts` extension: they are executed by Vitest (which resolves `.ts`), not compiled by the daemon's `tsc`.

### Task 4 — Test (AC: 1,2)

Create `test/isolation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const isolationProject = path.join(repoRoot, "test-fixtures", "isolation-project");
const noIsolationProject = path.join(repoRoot, "test-fixtures", "no-isolation-project");

describe("test isolation", () => {
  it("runs each file in a fresh context under isolate:true and reports isolate=true", async () => {
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "iso", path: isolationProject });
    // Both files' counters start at 1 => no cross-file leak.
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.success).toBe(true);
    expect(result.metadata?.isolate).toBe(true);
  }, 60_000);

  it("reports isolate=false when the project disables isolation", async () => {
    const orch = new Orchestrator({ workerPath });
    const result = await orch.runTests({ projectId: "noiso", path: noIsolationProject });
    expect(result.metadata?.isolate).toBe(false);
  }, 60_000);
});
```

### Task 5 — Verify (AC: all)

- [x] `pnpm run typecheck` → exit 0 (watch `noUnusedLocals`/`noUnusedParameters`; the new `isolate` param must be used).
- [x] `pnpm run build` → exit 0 (rebuilds `dist/worker/index.js` the tests fork).
- [x] `pnpm test` → all tests pass (existing suite + `isolation`). The existing `sample-project` tests are unchanged.
- [x] Sanity: a `run_tests` result's `metadata` now includes `isolate`.

### Review Findings

- [x] [Review][Defer] `TestResultSchema` stub does not validate `metadata.isolate` [`src/types/contracts.ts:51`] — deferred, pre-existing Story 1.0 placeholder
- [x] [Review][Defer] AC1 e2e may not distinguish `isolate:true` from parallel worker isolation [`test-fixtures/isolation-project/`] — deferred; story spec prescribed fixture without pool pinning; metadata AC2 path is sound

## Dev Notes

### What this story is really doing
Isolation is Vitest's own behaviour, not something the daemon implements. AC1 is *verified* (two test files sharing a mutable module both observe a fresh value under `isolate:true`), and AC2 is *surfaced* (the resolved `config.isolate` is copied into `TestResult.metadata`). No new tool, param, or client-facing control — the project's own Vitest config is the source of truth. [Source: epics §2.3; docs/architecture.md#Concurrency & Lifecycle]

### Why read the resolved config, not the fixture file
`vitest.config.isolate` on the running instance is the *resolved* value (defaults applied, CLI/programmatic overrides merged), so it is correct even when the project omits `isolate` (→ `true`). Reading the config file text would miss defaults. Default to `true` defensively only if the field were ever absent. [Source: docs/patterns.md#Running Vitest Programmatically]

### Fixture placement discipline
New fixtures go in their OWN dirs under `test-fixtures/` — do NOT add files to `sample-project/`, whose exact counts (`total:2, passed:1, failed:1`) are asserted by Story 2.1/2.2 tests. Fixtures stay outside `test/**` so the parent run never collects them and outside `src` so `tsc` never compiles them. [Story 2.1 fixture learning]

### Previous story intelligence
- **Do not touch dependencies / lockfile / `.npmrc` / `tsconfig` / the repo `vitest.config.ts`.** Pure application + fixtures. [Story 1.2; CLAUDE.md]
- **Metadata already flows to the client** through `TestResult`; adding a field needs no daemon/MCP change. [Story 2.1/2.2]
- **Hermetic tests:** fork the BUILT worker via an explicit `workerPath`; give run tests a generous timeout (`60_000`) since a real Vitest boots. [Story 2.1]
- `noUnusedLocals`/`noUnusedParameters` are ON — the new `isolate` parameter must be threaded through and used. [tsconfig]

### Project Structure Notes
`src/types/contracts.ts` and `src/worker/index.ts` are edited in place. Two new fixture dirs under `test-fixtures/` and one new test under `test/`. No new source files, no dependency/config changes, no orchestrator/daemon/MCP changes.

### Testing standards
Vitest, `environment: node`. Exercised through the real `Orchestrator` + built worker against the two new fixtures. The isolation-on case asserts behaviour (no cross-file leak) AND metadata; the isolation-off case asserts the metadata flag.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story 2.3: Test Isolation Verification]
- [Source: docs/architecture.md#Concurrency & Lifecycle]
- [Source: docs/patterns.md#Running Vitest Programmatically]
- [Source: docs/project-context.md]
- [Source: story-2-1-run-tests-via-project-local-worker.md (worker result mapping; fixture pattern; hermetic orchestrator test)]
- [Source: story-2-2-structured-results-failure-detail.md (metadata flows through TestResult)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

- `src/types/contracts.ts` — Added `isolate: boolean` to `TestResult.metadata`
- `src/worker/index.ts` — Extended Vitest typing, added `isolate` parameter to `mapModulesToResult`, read config and thread through result
- `test-fixtures/isolation-project/vitest.config.ts` — New fixture proving isolation (isolate: true)
- `test-fixtures/isolation-project/counter.ts` — Shared module with mutable counter for isolation testing
- `test-fixtures/isolation-project/a.test.ts` — Test file verifying fresh counter state
- `test-fixtures/isolation-project/b.test.ts` — Test file verifying no cross-file state leakage
- `test-fixtures/no-isolation-project/vitest.config.ts` — New fixture with isolation disabled
- `test-fixtures/no-isolation-project/noop.test.ts` — Trivial test for isolation-off verification
- `test/isolation.test.ts` — New test verifying both isolation modes

### Change Log

- **2026-07-14** — Story 2.3 implementation complete. Added per-file isolation detection and reporting.

### Completion Notes

Implemented Story 2.3: Test Isolation Verification. The worker now reads the resolved Vitest config.isolate value and includes it in TestResult.metadata. Two fixtures were created: isolation-project (isolate: true) verifies fresh per-file module state via shared counter module; no-isolation-project (isolate: false) surfaces the metadata flag. All tests pass including the new isolation.test.ts which validates both modes.
