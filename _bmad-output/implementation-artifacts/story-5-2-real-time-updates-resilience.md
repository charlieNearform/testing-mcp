# Story 5.2: Real-time Updates & Resilience

Status: done

> Implemented directly by the orchestrator (batch: Epics 4 + 5). Phase 2.

## Acceptance Criteria

1. When a test completes, the UI receives the result immediately and stays responsive under load. ✅
2. When the connection drops and reconnects, the UI shows the latest known state. ✅

## What shipped

- **`src/ui/index.ts`** — the `/ui/events` SSE stream:
  - Pushes a fresh snapshot on **every** run-state change (subscribed via
    `Orchestrator.onStatusChange`), so completions surface immediately.
  - Sends the current snapshot **immediately on (re)connect** — combined with `EventSource`'s automatic
    reconnect, a dropped connection recovers to the latest known state without user action.
  - Emits keep-alive comments every 15s and cleans up (unsubscribe + clear interval) on socket close, so
    long-lived and reconnecting clients don't leak.
- Snapshots are idempotent full-state payloads, so a late or duplicated event never corrupts the view.

## Tests
`test/ui.test.ts` — asserts the SSE stream delivers a snapshot immediately on connect, and again on a
second (re)connect, validating the resilience contract.

## Deferred (Phase 2 follow-ups)
- Per-event deltas / backpressure tuning for very large project counts (full snapshots are sufficient at
  Phase 2 scale).
