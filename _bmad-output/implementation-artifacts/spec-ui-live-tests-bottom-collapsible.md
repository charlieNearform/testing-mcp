---
title: 'UI: live tests to page bottom + collapsible, console log 2x height'
type: 'chore'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 0
context: []
route: 'one-shot'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** On the human monitoring UI's project page, the live per-test list sat right after the status banner (ahead of run history), and wasn't collapsible; the console log panel's fixed height (320px) was too short for comfortable reading.

**Approach:** Move the live-tests section to the bottom of the page (after the run-history table), wrap it in a native `<details>` so it's collapsible (console log keeps its existing position, right after the banner); double the log panel's `max-height` to 640px. Also fixed a bug this surfaced: both `<details>` panels are rebuilt from scratch on every SSE push (can fire on every test event), which previously reset any manually-collapsed panel back open on the very next push — added persisted open/closed state (mirroring the existing `followLog` pattern) so collapsing either panel now actually sticks.

</frozen-after-approval>

## Suggested Review Order

**Entry point**

- `renderProject()`: console log stays after the banner, live tests move to the bottom (both branches — the "no runs yet" early return and the main table view).
  [`src/ui/index.ts:499`](../../src/ui/index.ts#L499)

**Collapsibility that survives re-render (the fix beyond the literal ask)**

- `liveTestsBlock()` now takes `isOpen` and wraps itself in `<details id="live-tests-details">`.
  [`src/ui/index.ts:414`](../../src/ui/index.ts#L414)

- `wireLiveTestsPanel()` / `logOpen`+`liveTestsOpen` module state: a `toggle` listener persists each panel's open/closed state across the frequent full-DOM-replace re-renders — without this, collapsing either panel during a running suite silently re-expanded on the next test event.
  [`src/ui/index.ts:433`](../../src/ui/index.ts#L433)

**Peripheral**

- `#log-pre` max-height 320px → 640px.
  [`src/ui/index.ts:333`](../../src/ui/index.ts#L333)

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run build` -- expected: exit 0
- `pnpm test` (full suite) -- expected: 49/49 files pass (this change touches only `src/ui/index.ts` string-building logic with no async surface; confirmed clean)

**Manual checks (no automated coverage exists for this file's client-rendered HTML — pre-existing gap, not introduced here):**
- Screenshotted via a real daemon + real vitest run + headless Chromium: confirmed live tests render at the bottom with a collapse triangle, console log stays after the banner, and — critically — clicking to collapse live tests survives multiple subsequent SSE pushes while the run continues (does not silently re-expand).
