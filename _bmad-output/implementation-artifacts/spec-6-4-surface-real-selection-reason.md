---
title: 'Story 6.4 — Surface the real selection reason in run results'
type: 'refactor'
created: '2026-07-15'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
baseline_revision: '2d17f831f8dd9900a10185d720db9265dbcebe40'
final_revision: '478b5ae9a7a57d137af1309310f69148d999c511'
---

<intent-contract>

## Intent

**Problem:** A run's `TestResult.selection.reason` / `.strategy` are set by the worker's generic labels (`"full suite"`, `"explicit file selection"`), which mask *why* the selection happened. The orchestrator's `resolveSelection` already computes a specific reason (e.g. `"changed source unknown to coverage map: src/x.ts"`) but discards it, so agents and the UI never see the real decision.

**Approach:** After the worker returns, have the orchestrator stamp its own `reason`/`strategy` onto the result — overriding the worker's generic labels — while leaving `selection.files` as what actually ran. One exception: when the worker fell back to the full suite at execution time (git `--changed` found no affected tests) the worker's outcome is the truthful description and must be preserved.

## Boundaries & Constraints

**Always:** `selection.files` stays exactly what ran (the worker's `filesRun`). The stamp applies to both the empty-run path and the worker path. Preserve the existing error envelope and never crash the daemon. `pnpm run typecheck`, `pnpm build`, `pnpm test` all pass.

**Block If:** achieving this appears to require changing the `TestResult.selection` contract shape, the `SelectionEngine` reason strings, or the worker's `runVitest` logic — those are out of scope; HALT with the blocking condition.

**Never:** do not change *which* tests run (behaviour-preserving except the reported `reason`/`strategy`). Do not modify the worker's own label strings or `runVitest`. Do not fill the placeholder `TestResultSchema` (intentional Story-1.0 stub). Do not add dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Orchestrator chose full (unknown-to-map / full-suite trigger / not-a-git-repo / default) | worker ran full, labelled `"full suite"` | `reason` = orchestrator `sel.reason` (specific cause); `strategy` = `"full"` | none |
| Coverage-map union incremental | worker ran union | `reason` = `sel.reason` (`"coverage-map selection unioned with git static-graph"`); `strategy` = `"incremental"` | none |
| Empty (no changes) | no worker run (`sel.empty`) | `reason` = `sel.reason` (`"no changes detected"`); `strategy` = `sel.strategy` (NOT hardcoded `"incremental"`) | none |
| Changed-only, worker found affected tests | worker ran `--changed`, tests selected | `reason`/`strategy` = orchestrator's changed-only decision (`"incremental"`) | none |
| Changed-only, worker fell back to full | worker ran full (no affected tests); `sel.strategy` was `"incremental"` | **Preserve the worker's** reason (`"incremental found no affected tests…; ran full suite"`) + `strategy: "full"` — do NOT overwrite with the incremental decision | none |
| Explicit files | worker ran explicit files | `reason` = `sel.reason` (`"explicit file selection"`); `strategy` = `"incremental"` | none |

</intent-contract>

## Code Map

- `src/orchestrator/index.ts` -- `resolveSelection` (source of `sel.reason`/`sel.strategy`); `enqueue` (empty path); `execute`/`executeWorker` (thread `sel`; stamp at the `result` message branch); `emptyResult` (currently hardcodes `strategy: "incremental"`).
- `src/worker/index.ts` -- REFERENCE ONLY: produces `selection.reason`/`strategy`; leave unchanged.
- `src/types/contracts.ts` -- REFERENCE: `TestResult.selection` shape (`strategy: "full" | "incremental"`); no change.
- `test/selection-integration.test.ts`, `test/git-selection.test.ts` -- orchestrator-level `selection.strategy`/`reason` assertions; update expectations to the stamped values.
- `test/orchestrator-selection-reason.test.ts` -- NEW: assert the override + the fallback exception.

## Tasks & Acceptance

**Execution:**
- [x] `src/orchestrator/index.ts` -- threaded the resolved selection through `execute` → `executeWorker`; worker `result` branch stamps `result.selection.reason`/`.strategy` from `sel`, with the `result.selection.strategy === "full" && sel.strategy === "incremental"` fallback exception preserving the worker's values; `result.selection.files` untouched.
- [x] `src/orchestrator/index.ts` -- `runPlan`: fixed the committed-plan strategy derivation to `stored.changed || stored.files.length ? "incremental" : "full"` (a changed-only plan has empty `files` but runs incrementally) — was mislabelling committed changed-only runs "full". *(Review patch.)*
- [x] `src/orchestrator/index.ts` -- empty path: `emptyResult` reports `strategy: "incremental"` (an empty run is always an incremental no-op) — reverted the earlier parameterization that let a committed empty plan report "full". *(Review patch.)*
- [x] `test/orchestrator-selection-reason.test.ts` -- NEW hermetic test: full-decision reason ≠ "full suite"; empty-path reason/strategy; fallback exception preserved; **+ committed changed-only plan → "incremental"; committed empty plan → "incremental"** (runPlan regressions). 5/5 pass.
- [x] `test/selection-integration.test.ts`, `test/git-selection.test.ts` -- verified: assert only `selection.strategy`/`.files` (never `.reason`); expectations unchanged under the stamp → no edits required.

**Acceptance Criteria:**
- Given an incremental run the orchestrator resolves to full because a changed file is unknown to the map, when it completes, then `selection.reason` names the cause (not `"full suite"`) and `selection.strategy` is `"full"`.
- Given an incremental run with no changes, when it completes, then `selection.reason`/`.strategy` come from the orchestrator's resolution (strategy not hardcoded).
- Given a git `--changed` run that finds no affected tests and falls back to full, when it completes, then the worker's specific fallback reason and `strategy: "full"` are preserved.
- Given any run, when it completes, then `selection.files` lists exactly what ran.

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 2, medium 0, low 0)
- defer: 1: (high 0, medium 1, low 0)
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[high]` `[patch]` `runPlan` committed changed-only plan reported `strategy: "full"` (empty `files` but incremental) — fixed the derivation to `changed || files.length`; added a regression test.
  - `[high]` `[patch]` committed empty plan reported `strategy: "full"` via the parameterized `emptyResult` — reverted `emptyResult` to always `"incremental"` (empty = incremental no-op); added a regression test.
  - deferred: shared `msg.result` reference mutated in place and fanned to `recordRun`/`setRunState`/`resolve` (pre-existing shared-mutable-reference pattern; latent aliasing risk) → deferred-work.md.
  - rejected (noise): "override discards specific worker reasons" (intended — surfaces the decision reason; fallback exception covers the divergent case); "no guard for malformed `selection`" (IPC schema requires `selection`; worker always sets `strategy`); "`allTestsRun` still derived from `files.length`" (no defect).

## Design Notes

The orchestrator's `reason` describes the *decision*; the worker's describes *execution*. They agree except in the git-`--changed` → full-fallback case, where execution diverged from the decision. Detect that precisely by comparing the worker's reported `strategy` (`"full"`) against `sel.strategy` (`"incremental"`); only then defer to the worker. In every other case the orchestrator's decision reason is the more useful, specific value. `selection.files` is authoritative from the worker (`filesRun`) and never rewritten.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm build` -- expected: exit 0
- `pnpm test` -- expected: exit 0; new `orchestrator-selection-reason` test passes; updated selection/git tests pass

## Auto Run Result

Status: done

**Change:** The orchestrator now stamps its own resolved `selection.reason`/`.strategy` onto the run result, so callers/UI see *why* a selection happened (e.g. "changed source unknown to coverage map: X") instead of the worker's generic "full suite" label. `selection.files` stays exactly what ran. The git `--changed` execution-time full-fallback is detected (`worker "full" && decision "incremental"`) and the worker's truthful reason/strategy preserved.

**Files changed:**
- `src/orchestrator/index.ts` -- thread `ResolvedSelection` through `execute`/`executeWorker`; stamp reason/strategy at the worker `result` branch with the fallback exception; fix `runPlan` committed-plan strategy derivation (`changed || files.length`); `emptyResult` always `"incremental"` (empty = no-op).
- `test/orchestrator-selection-reason.test.ts` (new) -- 5 hermetic cases (stub worker + real git): full-decision reason ≠ "full suite"; empty path; git-`--changed` fallback preserved; committed changed-only plan → "incremental"; committed empty plan → "incremental".

**Review:** Blind Hunter + Edge Case Hunter (parallel). Triage: 2 patches applied (both high — committed changed-only + empty plan mislabelled "full"; fixed + regression-tested), 1 deferred (pre-existing shared `result` reference aliasing → deferred-work.md), 3 rejected as noise.

**Follow-up review recommended:** true — two high-consequence reporting fixes landed on the plan/commit path in the final pass; an independent confirmation is cheap insurance despite the fixes being localized and now test-covered.

**Verification:** `pnpm run typecheck` exit 0; `pnpm build` exit 0; `pnpm test` exit 0 (36 files, 127 tests). Lockfile untouched.

**Residual risks:** the deferred shared-`result` aliasing (latent, no current trigger); the stamp relies on the worker reporting an accurate `strategy` (validated at the IPC boundary; our worker always sets it).
