# Story 4.3: Minimal Failure-Focused Output

Status: done

> Implemented directly by the orchestrator (batch: Epics 4 + 5).

## Acceptance Criteria

1. The run summary includes counts and failures only; full detail is available via `get_failure_details`. ✅
2. Results are consistent JSON with metadata. ✅

## What shipped

- **`src/types/contracts.ts`** — `TestResult.summary`: a one-line, failure-forward string.
- **`src/worker/index.ts`** — `buildSummary()` produces `"<passed>/<total> passed, <failed> failed,
  <skipped> skipped (<ms>)"`, appending `— FAILED: <first few names>` when there are failures.
- The compact `failures[]` already carry only `{id, name, file, message}` (no stacks); full detail
  (`stack`/`expected`/`actual`/`diff`) remains available on demand via `get_failure_details`.
- `metadata` (timing + isolate) is always present, so every result is consistent JSON.

## Tests
`test/agent-workflow.test.ts` — asserts the summary foregrounds the failure, compact failures carry no
`stack`, and full detail is retrievable via `getFailureDetail`.
