---
title: 'Monitoring UI: surface running strategy, stop SSE re-renders from swallowing clicks; selection: size-based full-run escalation'
type: 'bugfix'
created: '2026-07-24'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'ed01b3cc64a9c1016aec75430f0e66baccc24309'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Three related, independently-observed issues found this session. (1) The monitoring
UI's "running" history row always shows a blank selection-strategy cell — the data was never
threaded from the orchestrator to the UI. (2) The UI's SSE handler does a full `innerHTML` rebuild
of the current view on *every* push (which fires on every test-progress event, across *all*
projects, to *every* connected tab) — destroying and recreating every project card / history row
every time, even unchanged ones. This drops clicks (a browser does not synthesize `click` when the
`pointerdown` target is removed before `pointerup` — confirmed as the mechanism, not a guess) and
wastes work re-rendering views nothing relevant changed in. (3) Incremental test selection has no
size-based escalation: when it ends up selecting most of the suite anyway, the per-file selection
overhead (git diff/static-graph analysis, coverage-map lookups) can make it slower than just
running everything, and there's currently no fallback for that.

**Approach:** (1) Add `strategy`/`reason` to the orchestrator's live `RunStatus`, set at the same
moment `state: "running"` is set (the resolved selection is already in hand there); render it in
the UI's live row. (2) Give the project-cards grid and the history table a persistent shell (built
once per view, like the existing console-log panel's persistent-node pattern) and reconcile their
children by key (`projectId`/`runId`) on each SSE push — untouched items keep their exact DOM node;
only items whose rendered content actually changed get their content replaced. Add a cheap
route-level check that skips calling render entirely when nothing relevant to the currently
displayed view changed. (3) Add a size-based escalation to `SelectionEngine.plan()`: when the
auto-computed incremental selection would run more than a configurable fraction of the project's
known test files, return `strategy: "full"` instead (confidence stays `high` — a full run is
provably complete regardless of why it was chosen).

## Boundaries & Constraints

**Always:**
- Preserve existing behavior for explicit `files: [...]` selections — the size-based escalation
  (3) applies ONLY to the auto-computed `mode: "incremental"` path with no explicit files.
- A zero/unknown total test-file count must never trigger the escalation (no denominator yet —
  skip the check, never divide-by-zero into "full").
- Unchanged rows/cards must not be touched (no attribute/innerHTML writes, no listener re-wiring)
  on a render pass where their underlying data didn't change — this is the actual fix, not an
  optimization on top of one.
- Keep the no-framework, inline-JS style of `src/ui/index.ts` — no new build step, no framework.

**Ask First:**
- If reconciling the live-tests list (`liveTestsBlock`) turns out to need materially different
  handling than the grid/table cases, stop and confirm scope before extending there.

**Never:**
- Do not attempt to preserve DOM identity for the row currently mutating (e.g. the live ticking
  row) mid-gesture — only claim untouched-row preservation; that narrower race is out of scope.
- Do not change the coverage-map build/persist paths (Story 3.7) — the escalation only changes
  which `strategy` a plan resolves to; downstream handling of `strategy: "full"` is unchanged.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Size escalation, fresh project | No test inventory yet (count 0) | `strategy: "incremental"` as today; no escalation | N/A |
| Size escalation, over threshold | Selection would cover >70% of known test files | `strategy: "full"`, `confidence: high`, reason names the fraction | N/A |
| Size escalation, explicit files | Caller passes `files: [...]` directly | Unaffected — escalation path never reached | N/A |
| Grid reconciliation, no change | SSE push with identical project summaries | Zero DOM writes to the grid; card nodes untouched | N/A |
| Grid reconciliation, one project changed | SSE push where only project B's counts changed | Only project B's card node's content is replaced | N/A |
| Route short-circuit | SSE push while viewing project A; only project B changed | `render()` is not called at all | N/A |

</frozen-after-approval>

## Code Map

- `src/orchestrator/index.ts:55-63` (`RunStatus`), `:544-549` (`executeWorker`, sets `state:"running"`) -- add/set `strategy`/`reason`.
- `src/orchestrator/index.ts:951-1029` (`testInventory`, `getTestInventoryCount`) -- add a file-count getter.
- `src/orchestrator/index.ts:447-479` (`resolveSelection`) -- thread the new count into `SelectionEngine.plan`.
- `src/selection/index.ts:37-60` (`SelectionInput`), `:181-192` (final incremental return) -- add the size check.
- `src/ui/index.ts:84-126` (`uiSnapshot`) -- surface `strategy`/`reason` on `ProjectView.run`.
- `src/ui/index.ts:443-452` (`renderList`), `:737-783` (`renderProject`), `:936-963` (`render`/SSE handler) -- persistent shells, reconciliation, short-circuit.

## Tasks & Acceptance

**Execution:**
- [x] `src/orchestrator/index.ts` -- add `strategy?: string; reason?: string` to `RunStatus`; set both in `executeWorker` alongside the existing `state: "running"` write, using `sel.strategy`/`sel.reason`.
- [x] `src/orchestrator/index.ts` -- add `getTestInventoryFileCount(projectId): number` (mirrors `getTestInventoryCount`, returns the inventory Map's `.size`, `0` if absent).
- [x] `src/orchestrator/index.ts` -- in `resolveSelection`'s incremental branch, pass `totalTestFileCount: this.getTestInventoryFileCount(project.projectId)` into the existing `SelectionEngine.plan({...})` call.
- [x] `src/selection/index.ts` -- add `totalTestFileCount?: number` to `SelectionInput`; add `TEST_MCP_INCREMENTAL_FULL_THRESHOLD` env-configurable fraction (default `0.7`, same floor/override convention as `TEST_MCP_MEASURE_BUDGET_MS`); in the final incremental return path, if `totalTestFileCount` is truthy and `selected.size / totalTestFileCount` exceeds the threshold, return `strategy: "full"` with `confidence: HIGH` and a reason naming the fraction (e.g. `"incremental selection would run 85% of the suite (312/366 test files); running full for speed"`) instead.
- [x] `src/ui/index.ts` -- add `strategy`/`reason` to `uiSnapshot()`'s `run` object (from `RunStatus`); replace the live row's hardcoded `<td></td>` (currently `src/ui/index.ts:759`) with `esc(p.run.strategy || "")`.
- [x] `src/ui/index.ts` -- give `renderList()`'s `.grid` and `renderProject()`'s history `<tbody>` a persistent shell (built once per project/route, reused across re-renders of the same view, torn down only on navigating away — same lifecycle shape as `ensureLogEl`/`placeLogEl`). Add a small reconciliation helper keyed by `projectId`/`runId`: cache each item's last-rendered HTML string by key; on each render, only write to a key's DOM node when its freshly-rendered HTML differs from the cached string; create nodes for new keys, remove nodes for keys no longer present, keep existing nodes' identity and listeners for unchanged keys.
- [x] `src/ui/index.ts` -- in the SSE `onmessage` handler, before calling `render()`, add a cheap check: if the current route's relevant data (the viewed project's `run`/`live`/`runs`, or the whole project list for the list route) is unchanged from the last snapshot, skip the render call entirely.
- [x] `test/selection.test.ts` (or the nearest existing `SelectionEngine.plan` unit-test file) -- add unit tests for the size-escalation edge cases in the I/O matrix above (zero total, over-threshold, at-threshold boundary, explicit-files unaffected).

**Acceptance Criteria:**
- Given a running job, when viewed in the monitoring UI, then its history row shows the same selection strategy a completed run would show, sourced live rather than blank.
- Given an SSE push whose data is unchanged for the currently viewed route, when it arrives, then no DOM node under `viewTop`/`viewBottom` is touched and `render()` is not invoked.
- Given an SSE push where only some projects'/runs' data changed, when the grid/table re-renders, then only the changed items' DOM nodes have their content replaced — unrelated items' node identity, scroll position, and listeners are preserved.
- Given an auto-computed incremental selection that would run more than the configured threshold fraction of known test files, when selection resolves, then it runs the full suite instead, at `confidence: "high"`, with a reason naming the fraction.
- Given a project with no test-file inventory yet, when an incremental selection is computed, then the size escalation never fires (no false "full" from a zero denominator).
- Given an explicit `files: [...]` selection request, when it is large relative to the project's total, then the size escalation is never applied (only the auto-computed incremental path is in scope).

## Design Notes

The reconciliation helper is intentionally minimal — no virtual-DOM diffing, just a per-key HTML-string cache:

```js
function reconcileChildren(container, items, keyOf, renderHtml, cache) {
  const seen = new Set();
  let prevEl = null;
  for (const item of items) {
    const key = keyOf(item);
    seen.add(key);
    const html = renderHtml(item);
    let el = container.querySelector('[data-key="' + key + '"]');
    if (!el) {
      el = document.createElement("div"); // or tr/a per caller
      el.dataset.key = key;
      cache.set(key, null);
    }
    if (cache.get(key) !== html) {
      el.innerHTML = html; // caller-provided renderHtml returns INNER content, not the outer tag
      cache.set(key, html);
    }
    // reorder: insert after prevEl if not already positioned there
    if (prevEl ? prevEl.nextSibling !== el : container.firstChild !== el) {
      container.insertBefore(el, prevEl ? prevEl.nextSibling : container.firstChild);
    }
    prevEl = el;
  }
  for (const el of [...container.children]) {
    if (!seen.has(el.dataset.key)) { el.remove(); cache.delete(el.dataset.key); }
  }
}
```

This means `card()`/row-template functions need their outer tag (`<a class="card">`/`<tr class="row">`) split from their inner content — the helper owns the outer element (created once, tagged with `data-key`), callers only supply inner HTML. Click listeners attach once at element-creation time (inside the `if (!el)` branch), not on every render.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run build` -- expected: exit 0
- `pnpm test` -- expected: exit 0, no regressions, new selection-threshold tests pass

**Manual checks (no CLI for the UI behavior):**
- Register a real project with 20+ test files, run it in a loop (e.g. via `start_watch` or repeated `run_tests`) to generate steady SSE churn, open `/ui`, and confirm: the running row shows a strategy; rapid clicking on history rows/project cards while ticks are landing reliably navigates (no missed clicks over ~20 attempts); DevTools Elements panel shows unrelated row/card nodes are NOT flashing/re-highlighted (a quick visual tell for `innerHTML` replacement) on unrelated updates.

## Dev Notes (execution)

**Verification actually run:**
- `pnpm run typecheck` -- exit 0.
- `pnpm run build` -- exit 0 (also restarts the local daemon, confirmed via `node ./bin/test-mcp.mjs restart` output).
- `pnpm test` -- 52 files / 324 tests, exit 0. One unrelated test (`test/ui-live.test.ts` > "a new run is still flagged (replace:true)...") flaked once under heavy machine load (dozens of pre-existing leaked `blocking-worker.mjs` processes from unrelated prior sessions were running concurrently) and passed both in isolation and on a clean full-suite re-run immediately after — a pre-existing, load-sensitive flake unrelated to this change (this repo's own `spec-vitest-pool-worker-start-retry.md` Verification section documents the same class of pre-existing flakiness).
- No browser/Playwright available in this environment (not an existing dependency, and adding one is off-limits per `CLAUDE.md`). In its place: (1) `node --check` against the `<script>` body extracted from a live `curl` of `/ui` — confirms the template-literal-escaping gotcha wasn't hit; (2) a hand-rolled minimal DOM shim (createElement/appendChild/insertBefore/querySelector/dataset/remove — the exact surface `reconcileChildren` touches) driving the ACTUAL extracted `reconcileChildren` source through create/update/no-op/remove passes, asserting node-identity preservation and zero writes on an unchanged key -- this is the concrete claim AC2/AC3 make; (3) a real end-to-end run against a hermetic `startDaemon()` instance (fresh `TEST_MCP_HOME`), registering a real ~20-file Vitest project and driving `register_project`/`run_tests` over the actual MCP StreamableHTTP interface (bearer auth included), confirming `GET /ui/api/status` shows `run.strategy: "full"` while `run.state === "running"`, and `"full"` again on the settled record — AC1 confirmed live, not just via unit test.

**Deviation found and fixed (flagged, not silently patched around):** implementing the escalation exactly as specified broke two PRE-EXISTING, unrelated regression tests: `test/git-selection.test.ts` > "a failed run leaves the snapshot unchanged so the same delta re-runs", and `test/selection-integration.test.ts` > "does not re-select an already-validated file's tests...". Root cause: `getTestInventoryFileCount` (the escalation's denominator, exactly as specified) reflects only what a given `Orchestrator` INSTANCE has itself reconciled so far — it starts at 0 for a fresh instance and only grows as ITS OWN runs execute files, regardless of what's on disk or what other instances did. Both fixtures' test-suites are tiny (2 real test files), so after the very first incremental run reconciled exactly 1 file, that 1-file inventory became the escalation's denominator for the next run's identical 1-file selection — 1/1 = 100%, over the 70% default, so it escalated to `"full"` and ran both files, which is what each test's un-related assertion (about selection *content*, not about this feature) then caught. This is a real interaction the spec's zero-denominator edge case didn't cover (a *partially warm* inventory, not just an *empty* one) — it never produces an unsafe result (escalating to full is always complete, per architecture invariant 5), but it does silently change already-tested selection behavior for any project whose in-memory inventory hasn't yet seen every test file at least once. Fix applied (not a spec change, and not a weakened assertion): each fixture now warms the inventory to the project's real total (2 files) before the assertion-relevant runs — one extra `mode:"full"` run in the git-selection case, one `orch.loadTestInventory(...)` call (mirroring real daemon-startup rehydration) in the selection-integration case — so the tests' original assertions are unchanged and still exercise exactly what they always exercised. Flagging this for the record rather than treating it as done-and-forgotten: the underlying "inventory takes N runs to warm up" behavior still applies to a REAL freshly-registered project in production (not just these test fixtures) — a brand-new project's first several incremental runs may escalate to full more than the "312/366 mature project" framing in the spec's own example reason string suggests, until the inventory has seen every test file at least once. Recorded in `deferred-work.md` (`spec-ui-rerender-and-selection-threshold` entry) during the review pass below.

### Adversarial review (Blind Hunter + Edge Case Hunter)

Both reviewers ran independently against the diff since `baseline_commit`. No `intent_gap`/`bad_spec` findings — everything routed to `patch` (applied below) or `defer` (the cold-start denominator issue above, already ledgered). All patches verified: `pnpm run typecheck`/`build` exit 0; `pnpm test` 52 files / 331 tests, exit 0.

**Patches applied:**
- `src/selection/index.ts` — `getIncrementalFullThreshold()` only guarded against `NaN`; `Number("")` is `0` (finite), so a blank env override silently became "escalate everything" instead of falling back to the default. Now range-checked to `(0, 1]`, falling back to the default outside that range too (covers blank/negative/`>1`). New tests cover blank, `0`, negative, and `>1`.
- `src/selection/index.ts` — the escalation's reported percentage could exceed 100% (`selected.size` can be larger than `totalTestFileCount` when a just-added file hasn't been reconciled into the inventory yet), reading as a nonsensical "150% of the suite." Clamped to 100 for display; the raw numerator/denominator are still shown. New test covers this.
- `src/selection/index.ts` — added two more branch-bypass unit tests (`strict`, `changed-only`) alongside the existing "only test files changed" one, so all three claimed-safe branches are independently verified, not just the one that already had a test.
- `src/ui/index.ts` — `reconcileChildren`'s per-key DOM lookup built a raw CSS attribute-selector string by concatenation (`[data-key="` + key + `"]`); a key containing a quote would throw a `SyntaxError` and break the whole render pass. Redesigned the cache from `Map<key, htmlString>` to `Map<key, {html, el}>` so the element is looked up by Map key, never by querying the DOM — eliminates the injection risk structurally (not just via escaping) and incidentally fixes the latent "keyOf must return a string" assumption (keys are coerced once, consistently, via `String(keyOf(item))`).
- `src/ui/index.ts` — `renderList()`'s own doc comment claimed `teardownHistoryTable()` runs when navigating to the list route; it didn't. Added the call. (Never caused a visible defect — the stale-but-cached table was harmlessly overwritten by the next reconciliation pass on return to the same project — but the code didn't do what its own comment claimed.)
- `src/ui/index.ts` — the header clock (`#clock`) only updated inside `renderList()`; the new SSE short-circuit can skip `render()` (and therefore `renderList()`) on a push whose route-relevant data is unchanged, silently freezing the clock even though the server keeps sending a fresh `serverTime`. Moved the clock update to the SSE `onmessage` handler, unconditional, before the short-circuit check.
- `src/ui/index.ts` — `reason` was threaded all the way from `SelectionEngine.plan()` to the UI payload but never rendered anywhere (only `strategy` was). Added it to the live-run detail page's timestamp line (matching how a completed run's detail page pairs `startedAt` with `sel.reason`) — the history table stays strategy-only for both live and completed rows, so this doesn't break table-row parity.
- `test/selection-integration.test.ts` — added an end-to-end escalation test through the REAL `Orchestrator` → `resolveSelection` → `SelectionEngine.plan` wiring (a 5-file project sharing one source, editing it selects 100% → escalates to full) and a comfortably-under-threshold counterpart (10 files, only one source-linked file touched → 10%, stays incremental) — closes the gap where only `SelectionEngine.plan()` itself had been unit-tested with a hand-fed `totalTestFileCount`.
- Re-verified `reconcileChildren` manually post-patch (no jsdom/Playwright available, and adding one is off-limits per `CLAUDE.md`'s dependency lock): extracted the actual served function from a live `curl` of `/ui` and drove it through a hand-rolled minimal element shim covering create / no-op-on-unchanged / update-in-place / remove / reorder / a selector-breaking key — all passed, including the specific injection-key scenario the CSS-selector patch above fixes. **Not committed as an automated regression test** — extracting-and-`eval`-ing client JS from a served page into the permanent suite was judged more fragile than valuable without jsdom; this remains a real, documented gap (see `deferred-work.md`) rather than a false-confidence test.

**Deferred (see `deferred-work.md` for full detail):**
- The escalation's denominator can under-count during a project's early "warm-up" period (a fresh/partially-warm in-memory inventory), causing more-eager-than-intended escalation until it stabilizes. Never unsafe, self-healing, already disclosed with a concrete follow-up suggestion.

**Rejected as noise / already-accepted / pre-existing-elsewhere:**
- Stale `strategy`/`reason` on an error path (confirmed unused once `state !== "running"`; no consumer reads it).
- No supporting benchmark for the 70% default (already an explicitly-flagged, user-confirmed heuristic guess, not an oversight).
- No pruning of deleted files from the test-file inventory (a pre-existing, already-documented characteristic of `testInventory`'s reconciliation semantics from an earlier story, not introduced here).

## Suggested Review Order

**Size-based full-run escalation**

- Entry point — the range-checked threshold parser (blank/negative/`>1` all fall back to the default; found via review, not anticipated originally).
  [`selection/index.ts:87`](../../src/selection/index.ts#L87)
- The escalation check itself — clamped percentage display, only reachable from the final auto-computed incremental return.
  [`selection/index.ts:213`](../../src/selection/index.ts#L213)
- The denominator source — grows only as an `Orchestrator` instance's own runs reconcile files (see the cold-start caveat in Dev Notes/`deferred-work.md`).
  [`orchestrator/index.ts:987`](../../src/orchestrator/index.ts#L987)
- Where it's threaded into the existing selection call.
  [`orchestrator/index.ts:484`](../../src/orchestrator/index.ts#L484)

**DOM reconciliation (the actual click-drop fix)**

- The reconciliation helper — Map<key, {html, el}>, no DOM-selector lookup (redesigned during review to close a CSS-injection risk).
  [`ui/index.ts:451`](../../src/ui/index.ts#L451)
- History table shell + row builder — outer `<tr>` created once, click listener wired at creation.
  [`ui/index.ts:825`](../../src/ui/index.ts#L825)
  [`ui/index.ts:863`](../../src/ui/index.ts#L863)
- `renderProject()` — wires the shell + reconciliation together; also releases the grid shell on entry.
  [`ui/index.ts:872`](../../src/ui/index.ts#L872)
- `renderList()` — same pattern for the project-cards grid; now also releases the history-table shell on entry (a review patch — the code previously didn't do what its own comment claimed).
  [`ui/index.ts:509`](../../src/ui/index.ts#L509)

**Route-level short-circuit + live strategy/reason**

- What a route actually depends on, for the SSE handler's "skip render entirely" check.
  [`ui/index.ts:1072`](../../src/ui/index.ts#L1072)
- The SSE handler — clock update moved here unconditionally (review patch — it used to freeze when the short-circuit skipped `renderList()`), then the short-circuit itself.
  [`ui/index.ts:1103`](../../src/ui/index.ts#L1103)

**Tests**

- Size-escalation edge cases at the `SelectionEngine.plan()` unit level (zero/blank/out-of-range env, boundary, percentage clamp, all three branch-bypasses).
  [`selection.test.ts`](../../test/selection.test.ts)
- The same escalation through the real `Orchestrator` wiring end-to-end (added during review — the unit tests alone never exercised this path).
  [`selection-integration.test.ts`](../../test/selection-integration.test.ts)
- Pre-existing fixture warm-up fix, needed once the escalation existed (see Dev Notes deviation writeup).
  [`git-selection.test.ts`](../../test/git-selection.test.ts)
