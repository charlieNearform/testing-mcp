# Story 4.1: Dry-Run Plan / Commit

Status: done

> Implemented directly by the orchestrator (batch: Epics 4 + 5).

## Acceptance Criteria

1. `run_tests({dryRun:true})` returns a `TestPlan` (planId, selected files, reasoning, expiresAt) without executing. ✅
2. `run_tests({planId})` with a valid, unexpired plan executes exactly the planned files and returns a `TestResult`. ✅
3. Expired/unknown `planId` → `PlanExpired` error so the agent re-plans. ✅
4. Dry-run latency recorded in `plan.metadata.latencyMs` (NFR1, not gated). ✅

## What shipped

- **`src/types/contracts.ts`** — `TestPlan` extended: `projectId`, `strategy`, `files`, `reasoning`,
  `createdAt`, `expiresAt`, `metadata.latencyMs`.
- **`src/orchestrator/index.ts`** —
  - `resolveSelection()` factored out of the run path so plan and commit share identical selection logic.
  - `plan(project, opts)` computes + stores a plan (TTL `planTtlMs`, default 5 min) and returns a `TestPlan`;
    stores the resolved `{files, changed, empty}` for exact replay.
  - `runPlan(project, planId)` validates (projectId match + expiry), consumes the plan (one-shot), and
    executes exactly the stored parameters via the per-project queue. Empty plans short-circuit.
  - `PlanError` (code `PlanExpired`).
- **`src/mcp/server.ts`** — `run_tests` handles `dryRun` (→ plan) and `planId` (→ commit); `PlanError`
  maps to a `PlanExpired` envelope.

## Tests
`test/plan-commit.test.ts` — dry-run does not execute; commit runs the planned files; unknown, consumed,
and expired planIds all reject with `PlanError`.
