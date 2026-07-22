---
title: 'Live run-detail log view, resizable console log height, and a working follow-off scroll'
type: 'feature'
created: '2026-07-22'
status: 'done'
review_loop_iteration: 0
context: []
route: 'one-shot'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The console log panel only ever appeared on the project page, with no way to jump straight to a specific in-progress run's own log; its height was a fixed, non-resizable CSS value; disabling "follow" didn't actually stop the log from snapping back to the top on every SSE-driven re-render; and the whole panel vanished the instant a run completed, discarding its content and forcing a full wipe (not a marked transition) the next time a run started.

**Approach:** Keep the existing project-page log panel (unchanged placement, now resizable) and add a run-history row for the currently in-progress run that links to a new live view on the run-detail page, showing that run's own status and console log. Both log panels share one resizable `#log-pre` height (native CSS `resize:vertical`, persisted to `localStorage`) instead of a fixed `max-height`, and correctly preserve scroll position across re-renders when "follow" is off. The project-page panel now stays visible once a project has ever run (only a manual collapse hides it), and its content is a client-side accumulating transcript across runs — a new run appends a "New test run started" separator instead of wiping the panel, fixing an underlying SSE endpoint bug that had been silently mislabeling the first push of a new run as a same-run append.

</frozen-after-approval>

## Suggested Review Order

**The new live run-detail view**

- `renderLiveRun()` — renders a run-detail page for the run currently in flight (status/progress/duration + its own console log), reached by clicking the new "running" row `renderProject()` prepends to the history table. `isLive` in `renderRun()` decides between this and the existing completed-run fetch by matching `live.runId`.
  [`src/ui/index.ts:596`](../../src/ui/index.ts#L596)
- `runId` added to the `LiveView` snapshot shape (server + client) so the running row and the live-run check both have something to match on.
  [`src/ui/index.ts:20`](../../src/ui/index.ts#L20)
- The SSE handler re-renders a run-detail page only while it's the one currently "live" (`viewingLiveRunId`), so it keeps updating in real time but still goes immutable the instant the run completes and its final `RunRecord` is fetched.
  [`src/ui/index.ts:744`](../../src/ui/index.ts#L744)

**Resizable, persisted, scroll-correct log panel**

- `#log-pre` is now a fixed (not max-) height with native `resize:vertical`; `applyStoredLogHeight()` reapplies the last size from `localStorage` on every re-render, since the element itself is destroyed and recreated on each one.
  [`src/ui/index.ts:337`](../../src/ui/index.ts#L337)
- `renderLogLines()` only forces scroll-to-bottom when "follow" is checked; otherwise it restores the caller-supplied scroll position instead of defaulting to the fresh node's `0`. Both callers (`renderProject()`, `renderLiveRun()`) capture that position from the outgoing node *before* `app.innerHTML` destroys it.
  [`src/ui/index.ts:479`](../../src/ui/index.ts#L479)
- `.log-summary`'s `display:flex` (needed to right-align the follow checkbox) drops the browser's native `<summary>` disclosure triangle that every other collapsible on this page still gets for free -- restored with an explicit `.chevron` span rotated via `details[open]`.
  [`src/ui/index.ts:588`](../../src/ui/index.ts#L588)

**Persistent, cross-run console transcript**

- The project page's log section now renders whenever the project has ever run (`everRan = running || runs.length > 0`), not only while `running` — so it survives a run completing. `wireLogPanel`/`closeLogStream` gating updated to match; the live-tests list stays running-only, unchanged.
  [`src/ui/index.ts:613`](../../src/ui/index.ts#L613)
- `logBuffer` — a per-project, client-side accumulating transcript (module-level state, capped at 2000 lines) that survives every DOM rebuild. `connectLog()` no longer does a separate one-shot GET reseed (that raced the SSE stream's own connect-time seed push and double-appended); the persistent EventSource is now the sole feeder, and a full DOM rebuild just repaints from `logBuffer`.
  [`src/ui/index.ts:459`](../../src/ui/index.ts#L459)
- **Bugfix:** the `/log/events` SSE handler updated its `lastSeenRunId` tracking variable on every push attempt, including ones with nothing to send yet. A run replaces the live log with a fresh, empty array before writing its first line, so an early, line-less status-change push (e.g. `case-start`) could silently consume the "this is a new run" signal — the *next* push (carrying the run's actual first line) then went out mislabeled as a same-run append. Fixed by only committing that state once a push actually sends something.
  [`src/ui/index.ts:237`](../../src/ui/index.ts#L237)

**Tests**

- `test/ui-live.test.ts` asserts the snapshot's `live.runId` is actually populated, not just that `live` exists.
  [`test/ui-live.test.ts:108`](../../test/ui-live.test.ts#L108)
- `test/ui-live.test.ts` — regression test reproducing the swallowed-run-boundary bug above via the blocking-worker fixture (two sequential runs, a line-less `case-start` before the second run's first line), asserting the push carrying that line is `replace:true`. Confirmed this fails without the fix and passes with it.
  [`test/ui-live.test.ts:169`](../../test/ui-live.test.ts#L169)

## Design Notes

**What's actually persisted, for the "do we have historic logs?" question:** No, not beyond the most recent run. The orchestrator retains one run's full console output in memory (bounded ring, evicted the instant the *next* run starts) — this is what backs "show the last run's log even when idle" and is not written to disk. The on-disk `RunRecord` history (`.test-mcp/history/*.json`, what backs the completed-run detail page) has never stored console output, only structured results. The cross-run transcript with "new run started" markers is an **in-tab, client-side buffer** — real, but scoped to one open browser tab; it resets on a page reload and was never intended as a durable log store. Making runs' console output durable across reloads/older runs would be a separate, larger change (disk-backed per-run log storage) and is out of scope here.

## Verification

**Commands:**
- `pnpm run typecheck` / `pnpm run build:compile` -- exit 0
- `pnpm test` -- 303/303 pass (one new regression test added; confirmed it fails without the SSE fix and passes with it)

**Manual check performed:** drove a real daemon + real vitest runs through headless Chromium (Playwright), all in one continuous browser session (no reload) to mirror real usage:
- Clicked the new "running" history row into the live run-detail view, watched real log lines stream in, dragged the panel to a new height (persisted across reload), unchecked "follow", set a mid-scroll position, and confirmed it survived several seconds of live SSE re-renders unchanged -- then re-checked "follow" and confirmed it snapped back to the bottom. Confirmed the view automatically switches to the final `RunRecord` the moment the run completes.
- Ran a first test to completion, confirmed the project-page log panel stayed visible and showed its line after completion (previously it vanished). Started a second run in the same tab and confirmed a "New test run started" separator appeared, with the first run's line still above it and the second run's line appended below. Collapsed the panel, waited through the rest of the run plus several more SSE pushes, confirmed it stayed collapsed, then re-expanded and confirmed the full two-run transcript was still intact.

