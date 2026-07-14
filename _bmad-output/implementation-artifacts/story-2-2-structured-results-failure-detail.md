baseline_commit: 46f2d19bc4f6e88b803ed1a2856df2bc701cddb7

# Story 2.2: Structured Results & Failure Detail

Status: done

**Prerequisite:** Story 2.1 complete (`Orchestrator` + project-local worker + `run_tests`, all `done`). Build on that code in place.

<!-- Implemented by a local model (qwen3-coder-next). Instructions are literal and copy-paste ready
     ON PURPOSE. Follow them exactly; do not infer or add scope. Read CLAUDE.md first — especially
     "Dependencies & install config (do NOT touch...)". This story adds NO dependencies. If a build
     error smells dependency-related, STOP and hand back to the orchestrator; do not thrash. -->

## Story

As an AI agent,
I want compact structured results plus on-demand failure detail,
so that I can react quickly without parsing verbose logs.

## Acceptance Criteria

1. **Compact structured result (already produced in 2.1 — keep it).** A completed `run_tests` returns consistent JSON with pass/fail/skip counts, duration, a compact `failures` list (`id, name, file, message` — no stacks), `selection`, and `metadata`. `run_tests` MUST NOT include full stack traces (progressive disclosure). (epics §2.2 AC1)
2. **On-demand failure detail.** `get_failure_details({ projectId, failureId })` returns that failure's full detail — assertion `message`, `stack`, and (when present) `expected`/`actual`/`diff` — for a `failureId` taken from the most recent run's `failures[].id`. Unknown/expired `failureId` → a clear error envelope; unregistered project → `UnknownProject`. (epics §2.2 AC2)

## Toolchain (from docs/project-context.md and CLAUDE.md — MUST follow)

- **pnpm only.** `pnpm run typecheck`, `pnpm run build`, `pnpm test`. Never `npm`/`yarn`. **Do NOT touch** `package.json` deps, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.json`, or `vitest.config.ts`.
- **ESM + NodeNext:** relative imports in `src/**` use the `.js` extension in the specifier; test imports use the `.ts` extension on relative source paths.
- Node 20+, `strict` TypeScript with `noUnusedLocals`/`noUnusedParameters` ON — no unused vars/params.
- **No new dependencies.**

## Scope boundaries (do NOT overstep)

- **Files you may create/modify — and ONLY these:**
  - `src/types/contracts.ts` — add the `FailureDetail` interface (Task 1).
  - `src/types/ipc.ts` — add `failureDetails?` to the `FromWorker` `"result"` message (Task 1).
  - `src/worker/index.ts` — add `mapFailureDetails(...)` and include it in the result IPC message (Task 2).
  - `src/orchestrator/index.ts` — cache the last run's failure details per project and expose `getFailureDetail(...)` (Task 3).
  - `src/mcp/server.ts` — implement the `get_failure_details` handler (Task 4).
  - `test/failure-details.test.ts` — new (Task 5).
- **Do NOT touch:** the `run_tests` handler (it already returns the compact result), `mapModulesToResult` (leave its compact `failures` exactly as-is), the daemon (the orchestrator is already wired in), the CLI, the HTTP listener/security code, `src/types/errors.ts`, `test-fixtures/`, or the scaffold layout.
- **Not in this story:** `get_test_status`/live status/progress (Epic 4.2 — leave it `NotImplemented`), coverage, selection, isolation reporting (Story 2.3), persistence of failure details across restarts (in-memory last-run cache is sufficient here).

## Verified facts to build on (current code + installed Vitest 4.1.9)

- `src/worker/index.ts` already has `mapModulesToResult(modules, unhandled, wallClockMs, requestedFiles)` producing the compact `TestResult`, and `runVitest(cwd, files)` which captures `modules`/`unhandled` via an inline `onTestRunEnd` reporter and sends `{ type: "result", runId, result }`. The compact `failures[].id` values are: `tc.id` for test failures, `` `${moduleId}::collect` `` for module load errors, and `` `unhandled-${i}` `` for unhandled errors. **Your detail list MUST reuse those exact ids** so `get_failure_details` can match.
- **Vitest 4.1.9 `TestError`** (the items in `TestCase.result().errors[]` and in `onTestRunEnd`'s `unhandledErrors`) has: `message: string`, `stack?: string`, `name?: string`, `diff?: string`, `actual?: string`, `expected?: string` — all strings. (Verified against `@vitest/utils` `types.d.ts`.)
- `src/orchestrator/index.ts` `Orchestrator.execute(project, files)` resolves a `TestResult` on the worker `"result"` message; `this` inside the message-handler arrow is the `Orchestrator` (safe to cache on `this`). `runTests(project, opts)` returns `Promise<TestResult>` — keep that signature (2.1 tests depend on it).
- `src/mcp/server.ts` `createMcpServer(deps)` has `const registry = deps.registry;` and `const orchestrator = deps.orchestrator;`, plus `unknownProject(...)`, `errorResult(...)`, and `toAppError(...)`. The `get_failure_details` tool is already registered with `inputSchema: { projectId, failureId }` and currently returns `requireRegisteredProject(projectId)`.
- `src/types/errors.ts` `ErrorCode` includes `ValidationError` (use it for an unknown/expired `failureId` — do not add a new code).

## Tasks / Subtasks

### Task 1 — Add the `FailureDetail` contract + IPC field (AC: 2)

**`src/types/contracts.ts`** — add this interface (below `TestResult`, above the placeholder schemas):

```ts
/** Full detail for a single failure, returned on demand by get_failure_details (Story 2.2). */
export interface FailureDetail {
  id: string;
  name: string;
  file: string;
  message: string;
  stack?: string;
  expected?: string;
  actual?: string;
  diff?: string;
}
```

**`src/types/ipc.ts`** — import `FailureDetail` and add it to the `"result"` message (optional, so older messages still typecheck):

```ts
import { TestResult, FailureDetail } from "./contracts.js";
```
```ts
  | {
      type: "result";
      runId: string;
      result: TestResult;
      coverageDelta?: CoverageDelta;
      failureDetails?: FailureDetail[];
    }
```
(Leave `CoverageDelta`, `ToWorker`, and the other `FromWorker` variants unchanged.)

### Task 2 — Produce failure details in the worker (AC: 2)

Edit `src/worker/index.ts`.

1. Extend the local `VError` interface to carry the assertion fields (the worker resolves Vitest dynamically, so these mirror `TestError`):
   ```ts
   interface VError {
     message?: string;
     stack?: string;
     name?: string;
     expected?: string;
     actual?: string;
     diff?: string;
   }
   ```
2. Import the `FailureDetail` type (type-only) at the top:
   ```ts
   import type { TestResult, FailureDetail } from "../types/contracts.js";
   ```
   (Replace the existing `import type { TestResult } from "../types/contracts.js";`.)
3. Add this pure function directly below `mapModulesToResult` (it walks the same structure and reuses the SAME ids):
   ```ts
   /** Build the on-demand failure detail list. Ids match mapModulesToResult's compact failures. */
   export function mapFailureDetails(
     modules: ReadonlyArray<VTestModule>,
     unhandled: ReadonlyArray<VError>,
   ): FailureDetail[] {
     const details: FailureDetail[] = [];

     for (const m of modules) {
       for (const err of m.errors()) {
         details.push({
           id: `${m.moduleId}::collect`,
           name: "(module load error)",
           file: m.moduleId,
           message: err.message ?? "Module failed to load",
           stack: err.stack,
           expected: err.expected,
           actual: err.actual,
           diff: err.diff,
         });
       }
       for (const tc of m.children.allTests()) {
         const r = tc.result();
         if (r.state === "failed" || r.state === "pending") {
           const e = r.errors?.[0];
           details.push({
             id: tc.id,
             name: tc.fullName,
             file: tc.module.moduleId,
             message: e?.message ?? (r.state === "pending" ? "Test still pending" : "Test failed"),
             stack: e?.stack,
             expected: e?.expected,
             actual: e?.actual,
             diff: e?.diff,
           });
         }
       }
     }

     unhandled.forEach((err, i) => {
       details.push({
         id: `unhandled-${i}`,
         name: "(unhandled error)",
         file: "",
         message: err.message ?? "Unhandled error during run",
         stack: err.stack,
       });
     });

     return details;
   }
   ```
4. In `runVitest`, compute the details and return BOTH from the function. Change its return type and body so it produces the result plus details:
   ```ts
   export async function runVitest(
     cwd: string,
     files: string[],
   ): Promise<{ result: TestResult; failureDetails: FailureDetail[] }> {
     // ...unchanged setup (createRequire, reporter, startVitest, wallClockMs, the !vitest guard)...
     try {
       return {
         result: mapModulesToResult(modules, unhandled, wallClockMs, files),
         failureDetails: mapFailureDetails(modules, unhandled),
       };
     } finally {
       await vitest.close();
     }
   }
   ```
5. Update the IPC `run` handler to send both:
   ```ts
   runVitest(process.cwd(), msg.files)
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

### Task 3 — Cache last-run failure details in the orchestrator (AC: 2)

Edit `src/orchestrator/index.ts`.

1. Import the type:
   ```ts
   import type { TestResult, FailureDetail } from "../types/contracts.js";
   ```
   (Replace the existing `import type { TestResult } from "../types/contracts.js";`.)
2. Add a field to the class (next to `queues`):
   ```ts
   /** Most recent run's failure details per project, keyed projectId -> (failureId -> detail). */
   private readonly lastFailures = new Map<string, Map<string, FailureDetail>>();
   ```
3. In `execute`, in the `msg.type === "result"` success branch (where `msg.result` is truthy), cache the details BEFORE resolving:
   ```ts
   } else if (msg.type === "result" && msg.runId === runId) {
     if (!msg.result) {
       finish(() => reject(new WorkerError("worker returned no result")));
     } else {
       const map = new Map<string, FailureDetail>();
       for (const d of msg.failureDetails ?? []) map.set(d.id, d);
       this.lastFailures.set(project.projectId, map);
       finish(() => resolve(msg.result));
     }
   }
   ```
4. Add a public accessor (next to `runTests`):
   ```ts
   /** Look up a failure from the project's most recent run. */
   getFailureDetail(projectId: string, failureId: string): FailureDetail | undefined {
     return this.lastFailures.get(projectId)?.get(failureId);
   }
   ```

### Task 4 — Implement `get_failure_details` (AC: 2)

Edit `src/mcp/server.ts`. Replace the `get_failure_details` handler body (currently `async ({ projectId }) => requireRegisteredProject(projectId)`) with:

```ts
    async ({ projectId, failureId }) => {
      const project = registry?.get(projectId);
      if (!project) return unknownProject(projectId);
      if (!orchestrator) {
        return errorResult(toAppError("NotImplemented", "orchestrator unavailable"));
      }
      const detail = orchestrator.getFailureDetail(projectId, failureId);
      if (!detail) {
        return errorResult(
          toAppError("ValidationError", `Unknown or expired failureId: ${failureId}`),
        );
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(detail) }] };
    },
```

(Leave the tool's `inputSchema` and `description` unchanged. Leave `get_test_status` as `requireRegisteredProject(projectId)`.)

### Task 5 — Test (AC: 1,2)

Create `test/failure-details.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { ProjectRegistry } from "../src/registry/project-registry.ts";
import { Orchestrator } from "../src/orchestrator/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
const fixture = path.join(repoRoot, "test-fixtures", "sample-project");

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

describe("get_failure_details over MCP", () => {
  it("returns full detail for a failing test, and errors on unknown ids/projects", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-faildetail-"));
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { projectId } = await registry.register(fixture);
    const orchestrator = new Orchestrator({ workerPath });

    const server = createMcpServer({ registry, orchestrator });
    const client = new Client({ name: "fail-detail", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    // Run, then pull the failing test's id from the compact result.
    const runRes = await client.callTool({ name: "run_tests", arguments: { projectId } });
    const result = JSON.parse(textOf(runRes)) as {
      failures: Array<{ id: string; name: string; message: string; stack?: string }>;
    };
    const failure = result.failures.find((f) => f.name.includes("intentional failure"));
    expect(failure).toBeTruthy();
    // Compact result must NOT carry stacks (progressive disclosure).
    expect(failure!.stack).toBeUndefined();

    // Full detail on demand.
    const detailRes = await client.callTool({
      name: "get_failure_details",
      arguments: { projectId, failureId: failure!.id },
    });
    const detail = JSON.parse(textOf(detailRes)) as {
      name: string;
      message: string;
      stack?: string;
      expected?: string;
      actual?: string;
    };
    expect(detail.name).toContain("intentional failure");
    expect(typeof detail.stack).toBe("string");
    expect(detail.stack!.length).toBeGreaterThan(0);
    // toBe(3) vs 2 => assertion detail present.
    expect(detail.expected).toBeDefined();
    expect(detail.actual).toBeDefined();

    // Unknown failureId => ValidationError.
    const unknownFail = await client.callTool({
      name: "get_failure_details",
      arguments: { projectId, failureId: "does-not-exist" },
    });
    expect(JSON.parse(textOf(unknownFail)).code).toBe("ValidationError");

    // Unknown project => UnknownProject.
    const unknownProj = await client.callTool({
      name: "get_failure_details",
      arguments: { projectId: "nope", failureId: "x" },
    });
    expect(JSON.parse(textOf(unknownProj)).code).toBe("UnknownProject");

    await client.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});
```

### Task 6 — Verify (AC: all)

- [ ] `pnpm run typecheck` → exit 0 (watch `noUnusedLocals`/`noUnusedParameters`).
- [ ] `pnpm run build` → exit 0 (rebuilds `dist/worker/index.js` used by the tests).
- [ ] `pnpm test` → all tests pass (existing 53 + `failure-details`). The existing `mcp-run-tests`/`worker-run` tests still pass unchanged (the compact `TestResult` is unchanged; only a new optional IPC field and a new tool handler were added).
- [ ] Sanity: `run_tests` output JSON contains no `stack` field inside `failures[]`; `get_failure_details` output does.

## Dev Notes

### What is actually new here
Story 2.1 already returns the compact, structured `TestResult` (counts, duration, compact `failures`, `selection`, `metadata`) — so AC1 is essentially met and MUST be preserved unchanged. The real work in 2.2 is **progressive disclosure**: keep `run_tests` compact (no stacks) and add a `get_failure_details` tool that returns the full assertion `message`/`stack`/`expected`/`actual`/`diff` for one failure, looked up by the `failureId` that already appears in `failures[].id`. [Source: docs/patterns.md#Result Formatting Pattern; epics §2.2]

### Where failure detail lives (and why in-memory is enough)
The worker computes both the compact result and the detail list from the same reporter data and sends both over IPC. The orchestrator caches the latest run's detail map per `projectId` in memory; `get_failure_details` reads it. This matches the architecture's "final `result` is authoritative; `get_failure_details` returns full stack/assertion on request" and needs no persistence in Phase 1 — an unknown/expired id simply returns `ValidationError` and the agent re-runs. [Source: docs/architecture.md#MCP Tool Contracts, §Daemon ↔ Worker IPC; docs/patterns.md#Result Formatting Pattern]

### Id stability (the one thing that must line up)
`get_failure_details` matching depends entirely on `mapFailureDetails` emitting the SAME ids as `mapModulesToResult`'s compact `failures`: `tc.id` for tests, `` `${moduleId}::collect` `` for collection errors, `` `unhandled-${i}` `` for unhandled errors. Do not "improve" the id scheme in only one place. `tc.id` is deterministic across runs (Vitest guarantees a stable id per test), so a `failureId` from one run resolves against that run's cached map.

### Vitest 4.1.9 error fields
`TestError` (items in `result().errors[]` and `onTestRunEnd` `unhandledErrors`) exposes `message`, `stack?`, `name?`, `diff?`, `actual?`, `expected?` — all strings. Pass them straight through into `FailureDetail`; do not stringify or reshape.

### Previous story intelligence
- **Do not touch dependencies / lockfile / `.npmrc` / `tsconfig` / `vitest.config`.** This story is pure application code. [Story 1.2; CLAUDE.md]
- **Keep `run_tests` compact.** Adding stacks there would break progressive disclosure (and Epic 4.3). Only `get_failure_details` returns stacks. [epics §2.2, §4.3]
- **Hermetic tests:** temp registry dir, close client/server in teardown, generous timeout (`60_000`) since a real Vitest boots. Fork the BUILT worker via an explicit `workerPath`. [Story 2.1]
- `noUnusedLocals`/`noUnusedParameters` are ON — no unused imports/vars. [tsconfig]

### Project Structure Notes
`src/types/contracts.ts`, `src/types/ipc.ts`, `src/worker/index.ts`, `src/orchestrator/index.ts`, `src/mcp/server.ts` are edited in place. One new test in `test/`. No new source files, no dependency or config changes, no daemon changes.

### Testing standards
Vitest, `environment: node`. Exercised end-to-end through the in-memory MCP transport with a real `ProjectRegistry` + `Orchestrator` against the existing `test-fixtures/sample-project` (whose `fail.test.ts` provides a deterministic failing assertion). Assert both the compact-vs-detailed split and the error paths.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story 2.2: Structured Results & Failure Detail]
- [Source: docs/architecture.md#MCP Tool Contracts]
- [Source: docs/architecture.md#Daemon ↔ Worker IPC]
- [Source: docs/patterns.md#Result Formatting Pattern]
- [Source: docs/project-context.md]
- [Source: story-2-1-run-tests-via-project-local-worker.md (worker result mapping; orchestrator IPC; hermetic MCP test pattern)]

## Dev Agent Record

### Agent Model Used
qwen3-coder-next

### Debug Log References

### Completion Notes
Successfully implemented Story 2.2: Structured Results & Failure Detail.

**Changes made:**
1. Added `FailureDetail` interface to `src/types/contracts.ts` with fields: id, name, file, message, stack?, expected?, actual?, diff?
2. Updated `FromWorker` IPC type in `src/types/ipc.ts` to include optional `failureDetails` array
3. Extended worker VError interface to carry assertion fields (name, expected, actual, diff)
4. Added `mapFailureDetails()` function in `src/worker/index.ts` that builds detailed failure list matching compact failure IDs
5. Modified `runVitest()` to return both result and failureDetails
6. Updated worker IPC handler to send failureDetails in result messages
7. Added `lastFailures` cache map to Orchestrator class for caching failure details per project
8. Cached failure details in orchestrator's execute() method when receiving result from worker
9. Added `getFailureDetail()` public accessor to retrieve cached failure details
10. Implemented `get_failure_details` MCP handler that validates project registration and returns full failure detail or appropriate error
11. Created comprehensive test file `test/failure-details.test.ts` verifying:
    - Full failure detail returned on demand (with stack, expected, actual)
    - Compact result contains no stacks (progressive disclosure)
    - ValidationError for unknown failureId
    - UnknownProject error for unregistered projects

**Verification results:**
- `pnpm run typecheck`: exit 0
- `pnpm run build`: exit 0  
- `pnpm test`: 54 tests passed (including new failure-details test)

### File List
- src/types/contracts.ts
- src/types/ipc.ts
- src/worker/index.ts
- src/orchestrator/index.ts
- src/mcp/server.ts
- test/failure-details.test.ts (new)

### Review Findings

- [x] [Review][Patch] Stale failure cache survives a failed subsequent run [src/orchestrator/index.ts:98-122] — `lastFailures` is only replaced on a successful `"result"` IPC message; worker error, timeout, and exit paths leave the prior map in place, so `get_failure_details` can return details from an older run after `run_tests` rejects.
- [x] [Review][Patch] Test file uses `.js` imports instead of story-required `.ts` [test/failure-details.test.ts:8-10] — sibling MCP tests (`mcp-run-tests.test.ts`) and the story Task 5 spec use `../src/.../*.ts` on relative source paths.
- [x] [Review][Patch] Error-path tests omit `isError` assertions [test/failure-details.test.ts:63-74] — other MCP tests (`mcp-registry.test.ts`, `mcp-server.test.ts`) assert `isError` alongside parsed `code`.
- [x] [Review][Patch] No test for expired `failureId` after a second successful run [test/failure-details.test.ts] — AC2 "unknown/expired" semantics are only exercised for a never-seen id, not cache replacement across consecutive runs.
- [x] [Review][Patch] Stale JSDoc on `runVitest` [src/worker/index.ts:175] — comment still says "returning a TestResult" but the function now returns `{ result, failureDetails }`.
- [x] [Review][Defer] Duplicate `${moduleId}::collect` ids collapse in orchestrator Map [src/worker/index.ts:132-137, src/orchestrator/index.ts:103] — deferred, pre-existing: `mapModulesToResult` already emits duplicate ids for multiple module collection errors (Story 2.1); Story 2.2 correctly mirrors that scheme.
- [x] [Review][Defer] `get_failure_details` during in-flight `run_tests` returns prior run's cache [src/orchestrator/index.ts:127] — deferred, pre-existing: lookups are not serialized with the per-project run queue; acceptable for Phase 1 in-memory cache semantics.
- [x] [Review][Defer] Unregister does not evict `lastFailures` entries [src/orchestrator/index.ts:36] — deferred, pre-existing: same pattern as `queues`; out of Story 2.2 scope.
