---
title: 'Story 6.8 — Selection confidence signal'
type: 'feature'
created: '2026-07-15'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
baseline_revision: 'a571af4cbee57a69fba493d407fec2096469241f'
final_revision: '051b85fcc880c03dc2ca2bff411c04e58297ac89'
---

<intent-contract>

## Intent

**Problem:** The old invariant 5 ran the FULL suite whenever selection couldn't prove completeness (e.g. a modified source unknown to the coverage map). The ratified course-correction softens this to "select tight + **report confidence**": run the bounded set and tell the caller when it may not fully cover the changes, so the AI runs a full pass at feature-completion instead of the tool always running full.

**Approach:** `SelectionEngine.plan` emits a `confidence: { level, reasons }` verdict alongside the plan (staying pure). A **modified** source unknown to the map is no longer forced to full — it is bounded by the git `--changed` static-graph union (like a new source in 6.6) and flagged `degraded` with a reason. Genuinely unbounded changes (build/test-config full-suite triggers, no-git) still run full and are `high` (a full run *is* complete). The orchestrator attaches the verdict to `TestResult.confidence`; the UI shows it. A `strict` opt-out restores the old force-full-on-uncertainty behaviour.

## Boundaries & Constraints

**Always:** `confidence` is additive/optional on `TestResult` — existing consumers keep working. `SelectionEngine.plan` stays pure and returns the verdict. A full run (any cause) is `high`. Only-test-files-changed and all-changed-sources-mapped are `high`. `degraded` cases each name their cause in `reasons`. Never a silent skip: a degraded run still returns and the reasons tell the agent to run full. `pnpm run typecheck`/`build`/`test` pass. Matches `docs/architecture.md` (invariant 5, selection-algorithm step 5, `TestResult.confidence`).

**Block If:** surfacing the verdict appears to need per-(source,test) attribution the plan inputs don't already have — implement the coarse verdict from the signals `plan` already sees (unknown-to-map, added-vs-modified, no-map, no-git) and DEFER finer granularity. If a case is genuinely ambiguous between "unbounded → full/high" and "bounded → degraded", default to the SAFER classification (full/high) and note it (per the story's escalation trigger).

**Never:** do not AUTO-run the full suite on degraded (the agent decides). Do not change coverage-map building. Do not alter `selection.files` semantics beyond the modified-unmapped softening. No new dependencies. Do not touch the placeholder `TestResultSchema` (IPC `resultShape` passes new fields through via `.passthrough()`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected verdict | Notes |
|----------|--------------|------------------|-------|
| Only test files changed | `a.test.ts` changed | `high`, reasons `[]` | AC1 |
| All changed sources mapped | `src/a.ts` (mapped) changed | `high`, reasons `[]` | AC1 |
| Modified source unknown to map | tracked `src/legacy.ts` modified, not in map | incremental (union), `degraded` reason names it | **behavior change**: was full |
| New source unknown to map | untracked `src/new.ts` (6.6 bounded) | incremental (union), `degraded` reason names it | dynamic-import risk (6.6/6.7 deferral) |
| Deleted source unknown to map | in changed set, not in map, not added | incremental (union), `degraded` names it | AC2 deletion-can't-be-bounded |
| Source changed, NO map yet | any source, `map === null` | changed-only, `degraded` (relying on static graph) | pure `--changed` |
| Full-suite trigger | `package.json`/config/setup-baseline | full, `high` | AC3 (complete) |
| No git | `changedFiles === null` | full, `high` | AC3 (complete) |
| No changes | empty changed set | incremental empty, `high` | trivially complete |
| `strict: true` + unknown-to-map source | any unmapped source | full, `high` | AC5 opt-out (old behaviour) |
| Execution-time full fallback | plan said degraded but worker ran full (`--changed` found nothing) | `high` (full actually ran) | orchestrator overrides to high |
| UI run-detail, degraded | a degraded run viewed | confidence badge + reasons shown | AC4 |

</intent-contract>

## Code Map

- `src/types/contracts.ts` -- add `confidence?: { level: "high" | "degraded"; reasons: string[] }` to `TestResult` (optional/additive). Leave `TestResultSchema` placeholder alone.
- `src/selection/index.ts` -- `SelectionInput` gains `strict?: boolean`. Each `SelectionPlan` variant carries `confidence: { level; reasons }`. `plan` accumulates degraded reasons; modified-unmapped source now `continue`s (bounded by union) + degraded, unless `strict` → full. No-map source-change (`changed-only`) is degraded. Keep `plan` pure.
- `src/orchestrator/index.ts` -- `ResolvedSelection` gains `confidence`; `resolveSelection` copies `plan.confidence` (full/explicit runs → high). Attach `result.confidence` in the worker-result and empty-run paths. On the 6.4 executionFallback (worker ran full despite an incremental decision), override to `{ level: "high", reasons: [] }` (a full run is complete). Thread `strict` through `runTests`/`plan` opts.
- `src/mcp/server.ts` -- `run_tests` input gains `strict?: boolean` (opt-out); forward it.
- `src/ui/index.ts` -- `renderRun`: show a confidence badge (`high`/`degraded`) + the reasons list, distinct from failures. Keep inline string-concat style.
- `test/selection.test.ts` -- pure verdict cases; update the 6.6 "modified-unmapped → full" case to "→ incremental + degraded"; add a `strict` force-full case.
- `test/orchestrator-selection-reason.test.ts` -- switch the 6.4 full-decision fixture to a genuine full-suite trigger (e.g. `package.json`) so it still exercises a `full` decision now that modified-unmapped is no longer full; assert confidence attaches.
- `test/git-selection.test.ts` -- update the "modified tracked unmapped → full" integration case to incremental + degraded.
- `test/worker.test.ts` (or the worker test file) -- union branch: when the merged module set is empty, fall back to a full run (no silent skip).
- `test/ui.test.ts` (if present) -- degraded badge/reasons render.

## Tasks & Acceptance

**Execution:**
- [x] `src/types/contracts.ts` -- added optional `confidence` to `TestResult`; **review patch:** a single `Confidence` interface is defined here (single source of truth) and imported by selection/orchestrator; `TestPlan` also carries optional `confidence` so a dry-run preview surfaces the verdict.
- [x] `src/selection/index.ts` -- `confidence` on every `SelectionPlan` variant; `SelectionInput.strict?`; modified-unmapped → bounded+degraded (strict → full); no-map source change → degraded (**review patch:** `strict` now forces full on the no-map path too); accumulate + name reasons; `plan` stays pure. **Review patch:** degraded reason wording covers "modified or deleted".
- [x] `src/orchestrator/index.ts` -- threads `confidence` into `ResolvedSelection` and onto `TestResult` (worker-result + empty paths); executionFallback overrides to high; `strict` threaded; `plan()` returns confidence; `runPlan` replays the stored verdict. **Review patch (HIGH):** `advanceSnapshotIfDeltaRun` no longer advances the last-run snapshot on a `degraded` run.
- [x] `src/mcp/server.ts` -- `run_tests` gains `strict?: boolean`.
- [x] `src/worker/index.ts` -- union branch full-suite fallback when the merged set is empty (silent-skip guard; the 6.6 deferral).
- [x] `src/ui/index.ts` -- confidence badge + reasons in `renderRun`. **Review patch:** degraded uses its own amber badge (not the red `fail` style) so a passing-but-degraded run doesn't read as a failure.
- [x] tests -- selection verdicts (high/degraded/strict incl. no-map); orchestrator attaches confidence + fallback→high + degraded-doesn't-advance-snapshot + dry-run-plan-confidence; worker union-empty→full; UI confidence round-trip; updated the 6.4/6.6 fixtures that assumed modified-unmapped→full.

**Acceptance Criteria:**
- Given a bounded, provably-complete incremental selection (only tests changed, or all changed sources mapped), the result carries `confidence: { level: "high", reasons: [] }`.
- Given a bounded-but-uncertain selection (modified source unknown to map, deleted unmappable file, or no coverage map), the result carries `confidence: { level: "degraded", reasons: [...] }` naming each cause — never a silent skip.
- Given a genuinely unbounded change (build/test config, setup-baseline, no git), the full suite runs and confidence is `high`.
- Given the UI run-detail for a degraded run, the confidence level and reasons are shown.
- Given `strict: true`, an unknown-to-map source restores the old force-full behaviour.

## Design Notes

The verdict is a REPORTING layer over signals `plan` already computes; the only behaviour change is that a modified unmapped source is bounded (union) + degraded rather than forced to full — the ratified invariant-5 softening. Unmeasurable (`alwaysRun`) tests do NOT degrade: they are force-run on every relevant change, so they are complete by construction (documented decision; matches the "default to the safer high/full classification when ambiguous" escalation rule). A full run — whether planned or reached via the worker's execution-time `--changed`→full fallback — is `high`, so the orchestrator overrides a planned `degraded` to `high` on executionFallback. The worker's union branch gains the same empty-set→full fallback the lone `--changed` branch already has, closing the one genuine silent-skip path (both signals select zero modules for a real change). `strict` is the AC5 opt-out that reinstates force-full-on-uncertainty for callers who want the old behaviour.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm build` -- expected: exit 0
- `pnpm test` -- expected: exit 0; new confidence unit/integration/UI cases pass; updated 6.4/6.6 fixtures pass

## Review Triage Log

### 2026-07-15 — Review pass (Blind Hunter + Edge Case Hunter, parallel)
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 1, medium 1, low 4)
- defer: 6: (high 0, medium 2, low 4)
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` **Degraded run advanced the last-run snapshot.** 6.8 softened modified-unmapped from full (complete → safe to baseline) to bounded+degraded, but `advanceSnapshotIfDeltaRun` still advanced on any successful delta run — baselining incompletely-covered files so they drop out of future deltas (a CROSS-RUN silent skip / false-clean). Added `if (result.confidence?.level === "degraded") return;` — degraded files stay in the delta until a `high` run (all mapped, or full) validates them (self-healing, safe). Regression test added.
  - `[medium]` `[patch]` **`strict` ignored on the no-map path.** The flag's contract is "force full on ANY unmapped-source uncertainty," but the `!map` early return never checked it. Added a `strict` → full branch there. Regression test added.
  - `[low]` `[patch]` **Dry-run `TestPlan` omitted confidence.** The verdict rode `TestResult` only, so a `dryRun` preview couldn't see it. Added optional `confidence` to `TestPlan` + `plan()` return. Regression test added.
  - `[low]` `[patch]` **`Confidence` shape duplicated** (contracts vs selection). Defined once in `src/types/contracts.ts`; selection/orchestrator import it (single source of truth per CLAUDE.md).
  - `[low]` `[patch]` **UI conflated degraded with failure.** `degraded` rendered with the red `fail` class. Gave it its own amber `badge.degraded` so a passing-but-degraded run isn't styled like a test failure.
  - `[low]` `[patch]` **Misleading degraded reason for deletions** ("modified source" for a deleted file). Reworded to "modified or deleted source".
  - deferred `[medium]`: **stale coverage map + a NEW dynamic dependent on the MAPPED path → false `high`.** `entry.lastMeasured` is never consulted; a dynamic edge added after the last measurement is invisible to both the stale map and `--changed`. Architectural (map freshness), not a 6.8 regression — the selection was identical pre-6.8, only the label is new. → Story 6.10 (coverage staleness/invalidation) + deferred-work.
  - deferred `[medium]`: **false `high` on the "only test files changed" path** when the changed file is a test-classified helper (a `__tests__/`-dir module or `*.test/spec.*` with no own tests) that other tests import; the worker's explicit-files branch has no empty→full fallback. Pre-existing selection behaviour (AC1, Story 3.x), explicitly out of 6.8's scope (which only surfaces the verdict). Same static-graph blind-spot family as the ratified relaxation. → deferred-work.
  - deferred `[low]`×4: only-deleted-test-files → 0 tests + `high` (worker runs nonexistent files); `runPlan` replays a plan-time verdict against a possibly-moved tree (by design — it replays the FROZEN selection, so the verdict matches what runs); executionFallback→high rests on the unguarded "worker only labels genuine full runs 'full'" convention (verified true for all three worker paths today; documented); union `staticRun=null` makes the "bounded by static graph" reason wording optimistic; `strict`+`planId` together silently drops `strict` (it's a plan-time flag). → deferred-work.
- verified_clean (probed, no defect):
  - executionFallback→high is sound: all three worker `strategy:"full"` emissions run a genuine `runOnce(startVitest, [], {})` full suite; a bounded run always reports `incremental`, so the high override never fires on a bounded set.
  - Mixed changed set: a full-suite trigger early-returns `full`+`high`; discarding an earlier degraded reason is correct because a full run is complete. No `full`+`degraded` path exists.
  - Empty-run path is always `high` (reasons are only populated on the `union:true` map branch, which is never the empty short-circuit).
  - UI: `esc` covers `& < > "`; all confidence insertions are text-content contexts (no attribute injection); undefined `confidence` omits the badge rather than throwing; no consumer defaults undefined to high.

## Auto Run Result

Status: done

**Change:** Each run now carries a `confidence: { level, reasons }` verdict (Story 6.8), softening invariant 5 from "when uncertain → full suite" to "select tight + report confidence." A MODIFIED source unknown to the coverage map is bounded by the git `--changed` static-graph union and flagged `degraded` (was: forced full), so the agent runs a full pass at feature-completion. Full-suite triggers / no-git still run full and are `high`. A `strict: true` opt-out restores the old force-full behaviour (now honoured on the no-map path too). The worker's union branch gained the empty→full fallback the lone `--changed` branch already had, closing the 6.6 silent-skip gap. Critically (review), a degraded run does NOT advance the Story-6.7 last-run snapshot, so its incompletely-covered files aren't silently baselined out of future deltas.

**Files changed:**
- `src/types/contracts.ts` -- `Confidence` interface (single source of truth); optional `confidence` on `TestResult` and `TestPlan`.
- `src/selection/index.ts` -- `plan` emits the verdict + names reasons; modified-unmapped → bounded+degraded; `strict` force-full (incl. no-map); stays pure.
- `src/orchestrator/index.ts` -- threads confidence onto results/plans; executionFallback→high; `advanceSnapshotIfDeltaRun` skips degraded runs; `strict` threaded.
- `src/worker/index.ts` -- union-branch empty→full fallback.
- `src/mcp/server.ts` -- `run_tests` gains `strict`.
- `src/ui/index.ts` -- confidence badge (amber for degraded) + reasons in `renderRun`.
- tests -- `selection`, `git-selection`, `orchestrator-selection-reason`, `ui-history` (verdicts, strict, degraded-no-advance, dry-run plan confidence, union fallback, UI round-trip; updated 6.4/6.6 fixtures).

**Review:** Blind Hunter + Edge Case Hunter (parallel). 6 patches applied (1 high: degraded-doesn't-advance-snapshot; 1 medium: strict on no-map; 4 low: plan confidence, type dedupe, UI badge, reason wording); 6 deferred (2 medium: stale-map/dynamic dependent → 6.10, only-test-files false-high → pre-existing selection gap; 4 low). Several probes verified clean (executionFallback soundness, mixed-set, empty-run, UI escaping).

**Follow-up review recommended:** false — the high-severity finding was patched with a regression test; the deferred items are pre-existing static-graph/map-freshness blind spots owned by the ratified relaxation and Story 6.10.

**Verification:** `pnpm run typecheck` exit 0; `pnpm build` exit 0; `pnpm test` exit 0 (37 files, 170 tests; +11 over the 159 baseline). Note: `test/watch.test.ts` occasionally times out under full-suite parallel load (worker starvation) — passes in isolation and on a clean run; pre-existing hermeticity flake, unrelated to this change.

**Residual risks (IMPORTANT):** a `high` verdict on the MAPPED path trusts coverage-map freshness — a dynamic dependent added after the last measurement is invisible (→ Story 6.10 staleness invalidation). The "only test files changed → high" path can over-claim if a test-classified helper with dependents changes (pre-existing; deferred-work). Both are the known static-graph blind spot behind the ratified invariant-5 softening.
