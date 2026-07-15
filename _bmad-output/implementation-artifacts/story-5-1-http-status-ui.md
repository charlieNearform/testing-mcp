# Story 5.1: HTTP Status UI

Status: done

> Implemented directly by the orchestrator (batch: Epics 4 + 5). Phase 2 convenience UI.

## Acceptance Criteria

1. With the daemon running, loading the UI page displays current test status for registered projects. ✅
2. While tests run, the UI updates without a manual refresh (SSE). ✅

## What shipped

- **`src/ui/index.ts`** —
  - `uiSnapshot(deps)` builds a JSON snapshot (registered projects + each project's run state).
  - `handleUiRequest(req, res, deps)` serves `GET /ui` (self-contained HTML page, no build step),
    `GET /ui/api/status` (JSON snapshot), and `GET /ui/events` (SSE stream).
  - The page (dark, responsive, vanilla JS) renders per-project cards with a status badge, live
    progress bar, pass/fail counts, and the failure-forward summary, subscribing via `EventSource`.
- **`src/mcp/server.ts`** — routes `/ui*` before `/mcp`, loopback-gated and GET-only with no bearer
  (same trust model as `/health`).
- **`src/orchestrator/index.ts`** — `onStatusChange(listener)` lets the SSE route push on every run-state
  change.

## Tests
`test/ui.test.ts` — the page is served over loopback without a token and references the live stream;
`/ui/api/status` returns a JSON snapshot with a `projects` array.

## Deferred (Phase 2 follow-ups)
- Manual run triggers and run history from the UI (would require an authenticated write path).
