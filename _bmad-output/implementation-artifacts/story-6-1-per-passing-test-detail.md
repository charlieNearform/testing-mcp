# Story 6.1: Per-Passing-Test Detail in Run Results

**ID:** `6-1`
**Slice:** `src/worker`, `src/types`, `src/ui`
**Type:** `feature`
**Depends on:** `6-0` (observability baseline: run history + UI run-detail shipped there)
**Status:** ready-for-dev

## Source

Follow-up from Story 6.0 / the monitoring-UI drill-down. Today the worker only itemizes
**failing** tests, so the UI run-detail view can show counts + failures but not the individual
tests that passed. Users want run-detail to show *everything that executed*.

- Related story: `story-6-0-post-v1-onboarding-hardening.md`
- Related: `docs/architecture.md` (§MCP Tool Contracts — `TestResult`), `docs/patterns.md`.

## Acceptance criteria

1. **Given** a run executes N tests
   **When** the worker builds the result
   **Then** the result carries a per-test list covering **all** tests that ran (passed, failed,
   skipped) — each entry has at least `{ name, file, status }` where `status ∈ passed|failed|skipped`.

2. **Given** a completed run in history
   **When** its detail is fetched (`GET /ui/api/projects/:id/runs/:runId`)
   **Then** the per-test list is present in the record and the UI run-detail view lists every
   test grouped or marked by status (failures still show message/stack as today).

3. **Given** a large suite
   **When** the per-test list is produced
   **Then** it is bounded: passing/skipped entries store `{ name, file, status }` only (no
   message/stack), and if the count exceeds a cap the list is truncated with a clear
   `truncated: true` / count indicator rather than growing unboundedly.

4. **Given** existing consumers of `TestResult`
   **When** the new field is added
   **Then** it is **optional/additive** — no existing field changes shape, and `run_tests`
   output plus all current tests still pass.

## Out of scope

- On-disk persistence of the detail — that is Story 6.2 (this story keeps it in the existing
  in-memory run-history + the live result).
- Flake/history analytics, per-test timing/durations, retries.
- Changing the `failures[]` shape or `get_failure_details` (leave both as-is).

## Notes for the agent

- **Worker (`src/worker/index.ts`)** — the result builder already walks Vitest test cases and
  `failures.push({ id, name, file, message })` for failing/pending ones (see the loop that reads
  `tc.fullName`, `tc.module.moduleId`, and `r.state`). Extend that same loop to also collect a
  `tests` entry for every case with a normalized `status`. Reuse the existing case iteration —
  do **not** add a second Vitest pass.
- **Contracts (`src/types/contracts.ts`)** — add an optional field to `TestResult`, e.g.
  `tests?: Array<{ name: string; file: string; status: "passed" | "failed" | "skipped" }>` plus
  an optional `testsTruncated?: boolean`. `TestResult` is a hand-written interface here (the Zod
  `TestResultSchema` is an intentional Story-1.0 placeholder — do **not** fill it in).
- **IPC (`src/types/ipc.ts`)** — `resultShape` in `parseFromWorker` uses `.passthrough()`, so the
  new field already crosses the boundary. Optionally add `tests` to `resultShape` as an optional
  array for explicit validation (keep `.passthrough()`).
- **Orchestrator** — no change needed: `RunRecord.result` stores the whole `TestResult`, so
  `tests` rides along into history automatically.
- **UI (`src/ui/index.ts`)** — in `renderRun`, after the selection/counts section, render a
  "tests" section from `rec.result.tests`, grouped or badged by status (green pass / red fail /
  muted skip). Keep the existing failures section for message/stack. If `testsTruncated`, show a
  note. Follow the existing inline-HTML string-concat style (no template literals / regex-with-
  slashes inside the `UI_HTML` template).
- Pick a cap constant (e.g. 1000) for AC3; state it in a comment.
- Every behavioural change ships with a test (worker result includes passing tests; UI detail
  endpoint/view surfaces them). Keep tests hermetic (temp dirs / the sample fixture).

## Escalation triggers

- If the Vitest advanced-API test-case object doesn't expose passing cases the same way it
  exposes failing ones (version drift), escalate rather than adding a second run or guessing.
