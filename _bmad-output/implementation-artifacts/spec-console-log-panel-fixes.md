---
title: 'Console log panel: persistent DOM node, ANSI colors, play/pause, relocate live-tests'
type: 'bugfix'
created: '2026-07-22'
status: 'done'
review_loop_iteration: 0
context: []
route: 'one-shot'
---

## Intent

**Problem:** The console log panel's DOM was rebuilt from scratch on every SSE-driven re-render (which fires on every test-progress event), so any in-progress text selection got wiped mid-copy and scroll behavior was unreliable. The live-tests panel showed on the project/history page when it's really about one in-flight run. Console output force-colored every stderr line red regardless of actual content, and there was no way to pause live updates to safely copy text.

**Approach:** Give the log panel's `<details>`/`<pre>` element a genuinely stable home: a dedicated `#view-log-slot` container that sits as a sibling of the two containers (`#view-top`/`#view-bottom`) every render actually rewrites, so the log element itself is never removed from the document by an unrelated re-render — confirmed via Playwright that a naive detach-and-immediately-reattach of the same node (an earlier version of this fix) does NOT reliably preserve browser text selection, only a true "never touched" ancestor does. Added a minimal ANSI SGR color parser (replacing the hard-coded red), a Play/Pause control that defers DOM updates while paused without losing any lines, and relocated the live-tests list to the live run-detail page.

## Suggested Review Order

**The persistent-DOM fix (the core of this change)**

- Entry point: the 3-slot page shell -- `view-log-slot` is the piece neither `renderProject()` nor `renderLiveRun()` ever assigns `.innerHTML` to.
  [`ui/index.ts:371`](../../src/ui/index.ts#L371)
- `placeLogEl()` only touches the slot's DOM when it doesn't already hold the exact same node -- a no-op on every subsequent render of the same project, which is what actually preserves selection/scroll.
  [`ui/index.ts:715`](../../src/ui/index.ts#L715)
- `ensureLogEl()` builds the element once per project and wires its listeners once (not on every render, which would stack duplicates on a node that's no longer recreated).
  [`ui/index.ts:672`](../../src/ui/index.ts#L672)
- `renderProject()`/`renderLiveRun()` now write to `viewTop`/`viewBottom` instead of the whole page.
  [`ui/index.ts:728`](../../src/ui/index.ts#L728)

**ANSI colors**

- `ansiToHtml()` -- matches the real CSI terminator (not just the next literal "m") so non-color sequences (cursor hide/show, line-clear) are consumed without corrupting surrounding text; maps basic SGR foreground codes to real colors instead of forcing stderr red.
  [`ui/index.ts:561`](../../src/ui/index.ts#L561)

**Play/Pause**

- `setLogPlaying()` / `connectLogStream()`'s onmessage -- paused defers DOM appends into `pendingLogEntries` (capped, nothing lost); resuming flushes and catches the scroll up.
  [`ui/index.ts:634`](../../src/ui/index.ts#L634)

**Live-tests relocation**

- Moved from `renderProject()` to `renderLiveRun()` -- it's about the one running job, not project history.
  [`ui/index.ts:782`](../../src/ui/index.ts#L782)

**Cleanup found via review**

- `closeLogStream()` now also disconnects the height `ResizeObserver` and clears the slot's real DOM, not just this file's own tracking variables.
  [`ui/index.ts:612`](../../src/ui/index.ts#L612)
- The "New test run started" marker uses the real server timestamp of the first line in the batch instead of client "now" (matters now that pausing can defer rendering arbitrarily).
  [`ui/index.ts:515`](../../src/ui/index.ts#L515)

## Verification

**Commands:**
- `pnpm run typecheck` / `pnpm run build:compile` -- exit 0
- `pnpm test` -- 311/311 pass

**Manual check performed (Playwright against a real daemon + real running test, this file has no automated browser-test harness):**
- Selected text inside the log panel, let ~4s of live SSE re-renders happen, confirmed the selection string was unchanged (this specifically caught the detach-reattach approach's real failure before the fixed-shell redesign).
- Confirmed the exact same `#log-pre` DOM node (tagged via a data attribute) survives navigating project page -> run-detail page -> back.
- Confirmed no `#live-tests-details` on the project page; confirmed it renders on the run-detail page for the live run, with the persistent log element also present there.
- Confirmed ANSI SGR color codes render as real colors (including a mid-line reset back to default), confirmed a non-color CSI sequence (cursor hide/show) did not swallow the text after it, confirmed no `class="fail"` red-forcing remains.
- Confirmed pause freezes the panel's content length while more lines arrive server-side, and resume flushes them in and catches the scroll up.
