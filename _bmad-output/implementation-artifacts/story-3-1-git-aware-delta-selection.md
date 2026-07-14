# Story 3.1: Git-Aware Delta Selection

Status: done

**Prerequisite:** Epic 2 complete (`run_tests`, worker/orchestrator, results/failure detail, isolation metadata — all `done`). This opens Epic 3 (intelligent selection). Build on the existing worker in place.

<!-- Implemented by a local model (qwen3-coder-next). Instructions are literal and copy-paste ready
     ON PURPOSE. Follow them exactly; do not infer or add scope. Read CLAUDE.md first — especially
     "Dependencies & install config (do NOT touch...)". This story adds NO dependencies. If a build
     error smells dependency-related, STOP and hand back to the orchestrator; do not thrash. -->

## Story

As an AI agent,
I want a fast git-based candidate selection,
so that obvious change sets are picked without building coverage.

## Acceptance Criteria

1. **Git-delta incremental run.** `run_tests({ projectId, mode: "incremental" })` runs the project's Vitest with `--changed` (config `changed: true`), so only test files affected by the git diff (via Vitest's static import graph) execute. The result reports `selection.strategy === "incremental"` and lists the selected test files. (epics §3.1 AC1; patterns §Git-Aware Delta Selection)
2. **No silent skip → full-suite fallback.** When incremental selection yields no affected test files — e.g. a changed file that no test statically imports, or the project isn't a git repo / `--changed` is unusable — the run conservatively falls back to the **full suite** and reports `selection.strategy === "full"` with a reason explaining the fallback. It never returns "0 tests, all good" for a change it couldn't map. (epics §3.1 AC2; architecture §Invariants (5) correctness-over-cleverness)

## Toolchain (from docs/project-context.md and CLAUDE.md — MUST follow)

- **pnpm only.** `pnpm run typecheck`, `pnpm run build`, `pnpm test`. Never `npm`/`yarn`. **Do NOT touch** `package.json` deps, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.json`, or the repo's `vitest.config.ts`.
- **ESM + NodeNext:** relative imports in `src/**` use the `.js` extension in the specifier; test imports use the `.ts` extension on relative source paths.
- Node 20+, `strict` TypeScript with `noUnusedLocals`/`noUnusedParameters` ON — no unused vars/params.
- **No new dependencies.** Git-delta is Vitest's own `--changed`; git is invoked only inside the test.

## Scope boundaries (do NOT overstep)

- **Files you may create/modify — and ONLY these:**
  - `src/types/ipc.ts` — add `changed: boolean` to the `ToWorker` `"run"` message (Task 1).
  - `src/worker/index.ts` — refactor a `runOnce` helper, drive `--changed` with a full-suite fallback, and make `mapModulesToResult` take an explicit `selection` (Task 2).
  - `src/orchestrator/index.ts` — thread a `mode` through `runTests` into the worker `run` message as `changed` (Task 3).
  - `src/mcp/server.ts` — pass `mode` from the `run_tests` input to the orchestrator (Task 4).
  - `test/git-selection.test.ts` — new (Task 5).
- **Do NOT touch:** `src/selection/index.ts` (the `SelectionEngine` stub stays untouched — the coverage-map union it will host arrives in Stories 3.2–3.5; git-delta in 3.1 is delegated to Vitest inside the worker), `src/types/contracts.ts` (`TestResult.selection` already has the right shape), the daemon, CLI, HTTP listener, or `test-fixtures/`.
- **Not in this story:** coverage map build (3.2), setup-baseline subtraction (3.3), unmeasurable-always-run (3.4), the coverage∪graph union decision (3.5), watch mode (3.6). Only `mode: "incremental"` uses `--changed`; `mode: "watch"` or anything else behaves as a full run for now.

## Verified facts to build on (current code + Vitest 4.1.9)

- `src/worker/index.ts` today:
  - `mapModulesToResult(modules, unhandled, wallClockMs, requestedFiles, isolate)` derives `selection.strategy`/`reason` from `requestedFiles.length`. You will replace `requestedFiles` with an explicit `selection` argument.
  - `runVitest(cwd, files)` builds the reporter, calls `startVitest("test", files, { watch:false, reporters, coverage:{enabled:false} })`, guards `if (!vitest) throw`, reads `isolate = vitest.config.isolate ?? true`, and returns `{ result, failureDetails }` in a `try/finally` closing vitest.
  - The IPC handler calls `runVitest(process.cwd(), msg.files)`.
  - `VitestInstance` is typed `{ close(): Promise<void>; config: { isolate: boolean } }`; `startVitest(...)` returns `Promise<VitestInstance | false>`.
- `src/types/ipc.ts` `ToWorker` `"run"` = `{ type:"run"; runId; files:string[]; coverage:boolean; allTestsRun:boolean }` (add `changed`).
- `src/orchestrator/index.ts` `runTests(project, opts: { files?: string[] })` → `execute(project, files)`; `execute` sends `{ type:"run", runId, files, coverage:false, allTestsRun: files.length===0 }`.
- `src/mcp/server.ts` `run_tests` handler destructures `{ projectId, files }` and calls `orchestrator.runTests(project, { files })`; its `inputSchema` already declares `mode: z.enum(["full","incremental","watch"]).optional()`.
- **Vitest `--changed`** = the config option `changed: true` (compares the working tree against `HEAD`). It selects test files whose static import graph reaches a changed file. It walks only *static* imports and needs a git repo; outside a repo it throws or selects nothing — hence the fallback. [patterns §Git-Aware Delta Selection]

## Tasks / Subtasks

### Task 1 — Add `changed` to the run IPC message (AC: 1)

**`src/types/ipc.ts`** — extend the `"run"` variant:

```ts
export type ToWorker =
  | {
      type: "run";
      runId: string;
      files: string[];
      coverage: boolean;
      allTestsRun: boolean;
      changed: boolean;
    }
  | { type: "cancel"; runId: string }
  | { type: "shutdown" };
```

### Task 2 — Drive `--changed` with a full-suite fallback in the worker (AC: 1,2)

Edit `src/worker/index.ts`.

1. Change `mapModulesToResult` to take an explicit `selection` instead of `requestedFiles`:
   ```ts
   export function mapModulesToResult(
     modules: ReadonlyArray<VTestModule>,
     unhandled: ReadonlyArray<VError>,
     wallClockMs: number,
     selection: { strategy: "full" | "incremental"; reason: string },
     isolate: boolean,
   ): TestResult {
   ```
   ...and where it builds the result's `selection`, use the passed value (keep `files: filesRun`):
   ```ts
     selection: {
       strategy: selection.strategy,
       reason: selection.reason,
       files: filesRun,
     },
   ```
   (Delete the old `requestedFiles.length ? ... : ...` logic; everything else in the function is unchanged.)

2. Replace the whole `runVitest` function with a version that factors out a single run and adds the incremental→full fallback:
   ```ts
   interface RunOnceResult {
     modules: ReadonlyArray<VTestModule>;
     unhandled: ReadonlyArray<VError>;
     wallClockMs: number;
     isolate: boolean;
   }

   /** Execute Vitest once with the given filters/options and capture reporter output. */
   async function runOnce(
     startVitest: VitestNode["startVitest"],
     filters: string[],
     extraOptions: Record<string, unknown>,
   ): Promise<RunOnceResult> {
     let modules: ReadonlyArray<VTestModule> = [];
     let unhandled: ReadonlyArray<VError> = [];
     const reporter = {
       onTestRunEnd(testModules: ReadonlyArray<VTestModule>, unhandledErrors: ReadonlyArray<VError>) {
         modules = testModules;
         unhandled = unhandledErrors;
       },
     };
     const start = Date.now();
     const vitest = await startVitest("test", filters, {
       watch: false,
       reporters: [reporter],
       coverage: { enabled: false },
       ...extraOptions,
     });
     const wallClockMs = Date.now() - start;
     if (!vitest) throw new Error("Vitest failed to start");
     const isolate = vitest.config.isolate ?? true;
     try {
       return { modules, unhandled, wallClockMs, isolate };
     } finally {
       await vitest.close();
     }
   }

   /** Resolve the PROJECT's Vitest and run it, honouring git-delta selection with a safe fallback. */
   export async function runVitest(
     cwd: string,
     opts: { files: string[]; changed: boolean },
   ): Promise<{ result: TestResult; failureDetails: FailureDetail[] }> {
     const projectRequire = createRequire(path.join(cwd, "__test-mcp-resolve__.js"));
     const { startVitest } = projectRequire("vitest/node") as VitestNode;

     const build = (
       r: RunOnceResult,
       selection: { strategy: "full" | "incremental"; reason: string },
     ) => ({
       result: mapModulesToResult(r.modules, r.unhandled, r.wallClockMs, selection, r.isolate),
       failureDetails: mapFailureDetails(r.modules, r.unhandled),
     });

     // Incremental (git-aware) selection — only when the caller did not pin explicit files.
     if (opts.changed && opts.files.length === 0) {
       try {
         const inc = await runOnce(startVitest, [], { changed: true });
         if (inc.modules.length > 0) {
           return build(inc, {
             strategy: "incremental",
             reason: "git delta via vitest --changed (static import graph)",
           });
         }
         // No affected test files -> fall through to a full run (never a silent skip).
       } catch {
         // Not a git repo / --changed unusable -> fall through to a full run.
       }
       const full = await runOnce(startVitest, [], {});
       return build(full, {
         strategy: "full",
         reason: "incremental found no affected tests (unmapped change or non-git); ran full suite",
       });
     }

     // Full run, or an explicit file list.
     const run = await runOnce(startVitest, opts.files, {});
     return build(run, {
       strategy: "full",
       reason: opts.files.length ? "explicit file list" : "full suite",
     });
   }
   ```

3. Update the IPC handler call to pass `changed`:
   ```ts
   runVitest(process.cwd(), { files: msg.files, changed: msg.changed })
     .then(({ result, failureDetails }) =>
       send({ type: "result", runId: msg.runId, result, failureDetails }),
     )
     .catch((err: unknown) =>
       send({
         type: "error",
         runId: msg.runId,
         message: err instanceof Error ? err.message : String(err),
         stack: err instanceof Error ? err.stack : undefined,
       }),
     );
   ```

### Task 3 — Thread `mode` through the orchestrator (AC: 1,2)

Edit `src/orchestrator/index.ts`.

1. Accept a `mode` in `runTests` and pass an `incremental` flag into `execute`:
   ```ts
   async runTests(
     project: ProjectRef,
     opts: { files?: string[]; mode?: string } = {},
   ): Promise<TestResult> {
     const prev = this.queues.get(project.projectId) ?? Promise.resolve();
     const run = prev
       .catch(() => undefined)
       .then(() => this.execute(project, opts.files ?? [], opts.mode === "incremental"));
     this.queues.set(project.projectId, run.catch(() => undefined));
     return run;
   }
   ```
2. Add the `changed` parameter to `execute` and include it in the run message:
   ```ts
   private execute(project: ProjectRef, files: string[], changed: boolean): Promise<TestResult> {
   ```
   ...and in the `ready` branch where the run message is built:
   ```ts
   const runMsg: ToWorker = {
     type: "run",
     runId,
     files,
     coverage: false,
     allTestsRun: files.length === 0,
     changed,
   };
   ```

### Task 4 — Pass `mode` from `run_tests` (AC: 1)

Edit `src/mcp/server.ts`. In the `run_tests` handler, destructure `mode` and forward it:

```ts
    async ({ projectId, files, mode }) => {
      const project = registry?.get(projectId);
      if (!project) return unknownProject(projectId);
      if (!orchestrator) {
        return errorResult(toAppError("NotImplemented", "orchestrator unavailable"));
      }
      try {
        const result = await orchestrator.runTests(project, { files, mode });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return errorResult(
          toAppError("WorkerFailure", err instanceof Error ? err.message : String(err)),
        );
      }
    },
```

(No `inputSchema` change — `mode` is already declared.)

### Task 5 — Test (AC: 1,2)

Create `test/git-selection.test.ts`. It builds a real git project so `--changed` has something to diff. The project lives in a temp dir OUTSIDE the repo, with its `node_modules` **symlinked** to the repo's so the worker resolves Vitest.

```ts
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

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
});
```

### Task 6 — Verify (AC: all)

- [ ] `pnpm run typecheck` → exit 0 (watch `noUnusedLocals`/`noUnusedParameters` — `mapModulesToResult` no longer takes `requestedFiles`).
- [ ] `pnpm run build` → exit 0 (rebuilds `dist/worker/index.js`).
- [ ] `pnpm test` → all tests pass (existing suite + `git-selection`). Existing full-run tests still pass — they assert `selection.strategy === "full"` and counts, which are unchanged (only the `reason` text changed).
- [ ] Sanity: `run_tests({mode:"incremental"})` on a project with an unmapped change returns `selection.strategy === "full"`, never an empty pass.

### Review Findings

- [x] [Review][Patch] Remove unused `beforeEach` import [test/git-selection.test.ts:1]
- [x] [Review][Defer] Add fast unit tests for `mapModulesToResult` selection branches [src/worker/index.ts] — deferred, pre-existing gap; story specifies E2E-only coverage
- [x] [Review][Defer] Assert `selection.reason` strings in git-selection tests [test/git-selection.test.ts] — deferred, not required by AC
- [x] [Review][Defer] Wire `dryRun`/`suite`/`planId` run_tests params [src/mcp/server.ts] — deferred, pre-existing; Story 4.1 scope
- [x] [Review][Defer] Consolidate `Orchestrator.execute` into options object as more run params arrive [src/orchestrator/index.ts] — deferred, style/refactor out of scope
- [x] [Review][Defer] Queue-serialization tests with `changed` flag [src/orchestrator/index.ts] — deferred, pre-existing coverage gap

## Dev Notes

### Why git-delta lives in the worker, not the SelectionEngine (yet)
Vitest's `--changed` already computes the git diff and walks the static import graph to pick affected test files — re-implementing that in a `SelectionEngine` would duplicate Vitest. So 3.1 delegates git-delta to Vitest inside the worker and leaves `src/selection/index.ts` a stub. The `SelectionEngine` becomes real in Stories 3.2–3.5, where it unions the coverage reverse-map with the static-graph signal and makes the conservative full-suite decision. Do not pre-build that here. [Source: docs/architecture.md#Component Overview (Selection Engine); docs/patterns.md#Git-Aware Delta Selection]

### The fallback is the whole point (invariant 5)
`--changed` is a fast first pass with known blind spots: it misses dynamic `import()`/DI/runtime deps and needs a git repo. The safe contract is **never skip silently** — if incremental maps to zero test files (unmapped change, or non-git), run the full suite and say so in `selection.reason`. This is the same "correctness over cleverness" rule the coverage engine will follow. Distinguishing "no changes at all" from "unmapped change" is a later efficiency refinement (3.5); for 3.1, falling back to full is correct and acceptable. [Source: docs/architecture.md#Invariants (5); docs/patterns.md#Git-Aware Delta Selection]

### Vitest `--changed` specifics
`changed: true` diffs the working tree against `HEAD`; a modified tracked source selects the test files that statically import it. With no explicit `files` filter, pass `changed: true` and an empty filter list. Reuse the existing single-run machinery (`runOnce`) for both the incremental attempt and the fallback so isolation/metadata handling stays identical.

### Testing the git path hermetically
The test project must (a) have git history to diff and (b) resolve the repo's Vitest. Since a bare temp dir has no ancestor `node_modules`, symlink `node_modules` → the repo's; then `git init`/`add`/`commit`, then modify a file to create an uncommitted diff. Vitest's default `exclude` skips `node_modules`, so the symlink's contents are not collected. Use `GIT_*` env vars for identity so no global git config is required. [Story 2.1 fixture/resolution learning]

### Previous story intelligence
- **Do not touch dependencies / lockfile / `.npmrc` / `tsconfig` / the repo `vitest.config.ts`.** Pure application code + one test. [Story 1.2; CLAUDE.md]
- **`selection`/`metadata` already flow to the client** via `TestResult`; no daemon/MCP shape change beyond forwarding `mode`. [Story 2.1–2.3]
- **Hermetic tests:** fork the BUILT worker via an explicit `workerPath`; clean up temp projects in teardown; generous timeout (`60_000`) since real Vitest boots (twice on the fallback path). [Story 2.1]
- `noUnusedLocals`/`noUnusedParameters` are ON. [tsconfig]

### Project Structure Notes
`src/types/ipc.ts`, `src/worker/index.ts`, `src/orchestrator/index.ts`, `src/mcp/server.ts` are edited in place. One new test under `test/`. `src/selection/index.ts` stays a stub. No new source files, no dependency/config changes.

### Testing standards
Vitest, `environment: node`. Exercised through the real `Orchestrator` + built worker against a temp git project (Vitest resolved via a `node_modules` symlink). Assert the incremental selection, the unmapped-change fallback, and the non-git fallback.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.1: Git-Aware Delta Selection]
- [Source: docs/architecture.md#Component Overview]
- [Source: docs/architecture.md#Invariants]
- [Source: docs/patterns.md#Git-Aware Delta Selection Pattern]
- [Source: docs/project-context.md]
- [Source: story-2-1-run-tests-via-project-local-worker.md (worker run machinery; fixture/resolution pattern)]
- [Source: story-2-3-test-isolation-verification.md (metadata threading through the worker)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

- `src/types/ipc.ts` — added `changed: boolean` to the `"run"` variant of `ToWorker`
- `src/worker/index.ts` — refactored `mapModulesToResult` to accept explicit `selection`, added `runOnce` helper, updated `runVitest` with incremental→full fallback logic, updated IPC handler to pass `changed`
- `src/orchestrator/index.ts` — threaded `mode` parameter through `runTests` → `execute` → worker message as `changed`
- `src/mcp/server.ts` — destructured and forwarded `mode` from `run_tests` input to orchestrator
- `test/git-selection.test.ts` — new test file with three hermetic tests for incremental selection, unmapped-change fallback, and non-git fallback

### Change Log

- **2026-07-14**: Story 3.1 implementation complete. Added git-aware delta selection using Vitest's `--changed` option with safe full-suite fallback when incremental selection yields no affected tests or when the project is not a git repository.

### Dev Agent Record

#### Agent Model Used

qwen3-coder-next

#### Debug Log References

None

#### Completion Notes

Successfully implemented Story 3.1: Git-Aware Delta Selection. The worker now supports incremental test runs via Vitest's `--changed` config option. When `mode: "incremental"` is specified:

1. If the project is a git repo and there are changed files that affect test modules, only those tests run (`strategy: "incremental"`).
2. If the change maps to no test files (unmapped dependency), the run falls back to the full suite with `strategy: "full"` and a descriptive reason.
3. If the project is not a git repo, the run immediately falls back to the full suite.

Three hermetic tests verify:
- Incremental selection correctly identifies affected tests based on static import graphs
- Unmapped changes trigger full-suite fallback (no silent skip)
- Non-git projects always use full-suite mode

All existing tests continue to pass; the `selection.reason` text was updated but the shape remains compatible.
