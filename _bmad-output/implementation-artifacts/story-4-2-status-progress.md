# Story 4.2: Status & Progress

Status: done

> Implemented directly by the orchestrator (batch: Epics 4 + 5).

## Acceptance Criteria

1. During a run, `get_test_status` returns `idle`/`running`/`complete`/`error` and the server emits
   `notifications/progress` during the run. ✅
2. After a completed/errored run, status returns the final results / error details. ✅

## What shipped

- **`src/orchestrator/index.ts`** — per-project `RunStatus` (`state`, `progress`, `lastResult`,
  `lastError`, `updatedAt`) maintained across the run lifecycle (`running` → `complete`/`error`),
  including progress updates from worker `progress` messages. `getRunStatus(projectId)` exposes it;
  `runTests`/`runPlan` accept an `onProgress` callback.
- **`src/worker/index.ts`** — the reporter now emits progress via `onTestRunStart` (total specs) and
  `onTestModuleEnd` (completed), forwarded as `{type:"progress"}` IPC messages.
- **`src/mcp/server.ts`** — `get_test_status` returns the merged run + watch snapshot; `run_tests`
  forwards progress as `notifications/progress` when the client supplies a `progressToken`.

## Tests
`test/agent-workflow.test.ts` — asserts the status machine reaches `running` then `complete`, exposes the
final result, and that progress callbacks fire with a known total.
