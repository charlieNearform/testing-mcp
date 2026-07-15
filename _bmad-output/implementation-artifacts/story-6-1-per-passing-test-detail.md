# Story 6.1: Per-Passing-Test Detail + Persistent Project Status Banner

**ID:** `6-1`
**Slice:** `src/worker`, `src/types`, `src/ui`
**Type:** `feature`
**Depends on:** `6-0` (observability baseline: run history + UI run-detail shipped there)
**Status:** done

## Source

Follow-up from Story 6.0 / the monitoring-UI drill-down. Two gaps: (a) the worker only itemizes
**failing** tests, so the UI run-detail view shows counts + failures but not the individual
tests that passed — users want run-detail to show *everything that executed*; and (b) once you
click into a project, the root page's live current-status is lost, so there's no at-a-glance
"what is this project doing right now" while browsing its history.

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

5. **Given** the project run-history view is open (clicked in from the root list)
   **When** it renders and as runs progress
   **Then** the project's **current** run state — the same status shown on the root-page card
   (state badge + latest summary/counts) — is pinned as a **banner at the top of the view**,
   and it updates live via SSE without leaving the view.

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
- **Status banner (AC5)** — in `renderProject`, before the run table, render a banner from the
  project's current entry in the client-held `snapshot.projects` (same fields the root `card`
  uses: state badge + summary/counts). The SSE `onmessage` handler already updates `snapshot`
  and re-renders the project view, so the banner updates live for free — just make sure the
  project view is re-rendered on snapshot ticks (it is today). Reuse the `badge()` helper.
- Pick a cap constant (e.g. 1000) for AC3; state it in a comment.
- Every behavioural change ships with a test (worker result includes passing tests; UI detail
  endpoint/view surfaces them). Keep tests hermetic (temp dirs / the sample fixture).

## Escalation triggers

- If the Vitest advanced-API test-case object doesn't expose passing cases the same way it
  exposes failing ones (version drift), escalate rather than adding a second run or guessing.

## Auto Run Result

Status: done (dev-auto 2026-07-15)

**Change:** `mapModulesToResult` now emits a per-test `tests: [{ name, file, status }]` list covering every case that ran (passed/failed/skipped; `pending`→failed; module-load + unhandled errors → failed entries), in the SAME pass as counts/failures — no second Vitest run. Bounded at `MAX_TEST_ENTRIES = 1000` with `testsTruncated`. Added optional `tests`/`testsTruncated` to `TestResult`; the run-detail UI lists every test badged by status (failures keep their message/stack section). Added a live status banner to the project history view, sourced from the SSE-updated `snapshot.projects` so it ticks without leaving the view.

**Files changed:** `src/types/contracts.ts` (optional `tests`/`testsTruncated`), `src/worker/index.ts` (per-test list + cap), `src/types/ipc.ts` (optional `tests` in `resultShape`, `.catch(undefined)` so a malformed list degrades rather than failing the run), `src/ui/index.ts` (tests section + `statusBanner` + CSS). Tests: `test/worker-result.test.ts` (NEW — list/statuses/truncation/unhandled/module-load), `test/worker-run.test.ts` + `test/ui-history.test.ts` + `test/ipc-validation.test.ts` (assertions).

**Review:** Edge Case Hunter (single proportionate pass — small additive story). 2 patches applied: (1) unhandled errors are now included in `tests` and the cap is computed AFTER all entry sources, so the list matches the failed count; (2) the IPC `tests` schema uses `.catch(undefined)` so a version-skewed/malformed entry degrades to "no detail" instead of throwing and rejecting the whole run. 2 low/notes deferred (banner interpolates daemon-computed integers without `esc()` — mirrors the existing `card()` style, not user input; banner-vs-table transient skew + innerHTML rebuild dropping scroll — pre-existing `renderProject` behaviour). → deferred-work.

**Verification:** `pnpm run typecheck` exit 0; `pnpm build` exit 0; `pnpm test` exit 0 (38 files, 176 tests).
