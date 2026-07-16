---
title: 'Unbounded worker run timeout and resilient MCP bridge sessions'
type: 'bugfix'
created: '2026-07-16'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '33a1791ca6852b7c8e478b6c2056afc474e170bb'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The daemon's worker-execution timeout is hard-coded at 120s (`Orchestrator.runTimeoutMs`), so any suite taking longer — confirmed at 15-20 minutes on a slower real-world machine — gets killed mid-run. Independently, the MCP bridge (`test-mcp mcp-bridge`) that pipes an IDE's stdio MCP client to the daemon's HTTP transport has no resilience: the SDK's `StreamableHTTPClientTransport` gives up SSE-reconnecting after only 2 attempts (default `maxRetries`), and once the daemon-side session is gone for any reason, every subsequent request 404s ("Session not found") and is silently swallowed forever — the bridge never recovers, forcing the user to restart their whole MCP connection and lose the in-flight tool call's result. Root-causing *why* a session is lost mid-run (vs. just recovering from it) is out of scope here.

**Approach:** Make the worker-run timeout configurable via `DaemonConfig`, with no cap by default. Raise the MCP client transport's SSE-reconnection tolerance so transient blips during a long run self-heal via the SDK's own backoff instead of giving up after 2 tries. When a request to the daemon fails because the session itself is gone (HTTP 404), have the bridge transparently recreate the session (replaying the cached `initialize` handshake) and retry the failed message once, instead of silently swallowing every request from then on.

## Boundaries & Constraints

**Always:**
- `Orchestrator.runTimeoutMs` stays a per-instance constructor option (tests can still inject a small value); only the *default* changes, from `120_000` to "no cap."
- A "no cap" timeout never schedules a `setTimeout` at all — never pass `Infinity`/huge numbers to `setTimeout` directly (Node's 32-bit signed delay overflows and fires almost immediately above ~24.8 days).
- The bridge's recreate-session path triggers ONLY on a `clientTransport.send()` failure whose message contains `HTTP 404` (matches the SDK's own `Error POSTing to endpoint (HTTP ${status})` format) — every other error type keeps today's log-only behavior, unchanged.
- The bridge caches the raw `initialize` request and `notifications/initialized` notification as they're forwarded (needed to replay a fresh handshake) and replays them, in order, against a newly constructed `StreamableHTTPClientTransport` (with the same `onmessage`/`onerror`/`onclose` handlers re-bound) before retrying the original failed message once.
- Concurrent send failures must not each race to recreate the transport — serialize recreation behind a single in-flight promise so simultaneous failures share one recreation attempt.
- If the retried message ALSO fails, log to stderr and give up on that message — never loop or retry indefinitely.

**Never:**
- Do not investigate or fix why the daemon's in-memory session might be evicted in the first place (crash, restart, or otherwise) — this spec makes long runs resilient to a session loss, whatever its cause; that investigation is tracked separately.
- Do not change the MCP protocol/message shapes the bridge forwards — only add transport-level reconnect/recreate behavior around the existing raw pipe.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Long run, default config | No `runTimeoutMs` configured; a run takes 15+ minutes | Completes normally, no `WorkerError` timeout | N/A |
| Operator wants a safety net | `runTimeoutMs: 600000` set in `config.json` | A run exceeding 10 min still fails with today's `WorkerError` timeout | Existing behavior preserved |
| Transient SSE blip mid-run | The SSE stream disconnects once | Reconnects on the SDK's own backoff; no user-visible error | N/A |
| Daemon session genuinely gone | A `send()` POST returns HTTP 404 "Session not found" | Bridge recreates the transport, replays the cached handshake, retries the original message once, and it succeeds | If the retry ALSO 404s, log and give up on that message only |
| 404 before any `initialize` was ever forwarded | Nothing cached yet | No replay attempted (nothing to replay) | Falls back to today's log-only behavior |

</frozen-after-approval>

## Code Map

- `src/orchestrator/index.ts` -- `runTimeoutMs` default and the `setTimeout` scheduling inside `executeWorker`.
- `src/daemon/index.ts` -- `DaemonConfigSchema` + wiring into `new Orchestrator(...)`.
- `src/cli/main.ts` -- the `mcp-bridge` command: `StreamableHTTPClientTransport` construction/`reconnectionOptions`, message caching, and the 404-triggered recreate-and-replay path.

## Tasks & Acceptance

**Execution:**
- [x] `src/orchestrator/index.ts` -- default `runTimeoutMs` to `undefined` (no cap); only schedule the `setTimeout` when a finite value is configured -- allows runs of any length by default
- [x] `src/daemon/index.ts` -- add optional `runTimeoutMs: z.number().optional()` to `DaemonConfigSchema`; pass `cfg.runTimeoutMs` into `new Orchestrator(...)` -- lets an operator opt into a cap without forcing one on everyone
- [x] `src/cli/main.ts` -- pass a far more tolerant `reconnectionOptions` (raise `maxRetries` well past the SDK default of 2, with capped backoff) to `StreamableHTTPClientTransport` -- survives transient blips over a 15-20+ minute run
- [x] `src/cli/main.ts` -- cache the forwarded `initialize` request and `initialized` notification; on a send failure whose message contains `HTTP 404`, recreate the transport (re-binding handlers), replay the cached handshake, and retry the original message once (serialized behind one in-flight recreation) -- converts a dead session into a transparent one-time recovery
- [x] Tests -- orchestrator: no timeout by default over a synthetic long-running stub worker; an explicit small `runTimeoutMs` still fails fast. Bridge: a 404 send failure triggers recreate+replay+retry-once, and a second 404 gives up cleanly without looping

**Acceptance Criteria:**
- Given no `runTimeoutMs` configured, when a worker run takes far longer than 120s, then it completes normally with no timeout failure.
- Given `runTimeoutMs: 5000` configured, when a run exceeds 5s, then it still fails with today's `WorkerError` timeout message.
- Given the daemon-side session is gone and the bridge forwards a request, when the POST 404s, then the bridge recreates the session and the retried request succeeds without the user seeing a permanent "Connection closed"/black-hole failure.

## Spec Change Log

## Design Notes

The SDK's `StreamableHTTPClientTransport` only fires `onerror` (never `onclose`) when its own SSE-reconnect budget is exhausted, and a 404 on a plain POST `send()` is just a rejected promise at the call site (`src/cli/main.ts`'s `serverTransport.onmessage` handler) — neither path tears down the bridge process today, they just log and silently stop working. That's why every subsequent request 404s forever with no crash: the bridge is alive but the daemon-side leg is a black hole. Recreating the transport (rather than trying to resume the same session) sidesteps needing to know *why* the old session died.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run build` -- expected: exit 0
- `pnpm test` -- expected: exit 0

**Manual checks (if no CLI):**
- A genuine 15-20 minute real-suite run isn't practical to reproduce in CI; rely on the unit tests (synthetic slow worker, mocked 404) plus code review for confidence on the timing-dependent paths.

## Suggested Review Order

**Bridge session recovery (the core fix)**

- Entry point: raised SSE reconnect budget and the transport factory used everywhere a fresh transport is needed.
  [`main.ts:467`](../../src/cli/main.ts#L467)

- Recreate-and-replay: builds a fresh transport, replays the cached handshake, and — critically — neutralizes and closes the superseded transport so it can't spuriously kill the bridge later.
  [`main.ts:513`](../../src/cli/main.ts#L513)

- Requires BOTH handshake messages cached before attempting recovery, so a partial replay never leaves the server-push channel unopened.
  [`main.ts:539`](../../src/cli/main.ts#L539)

- The pure 404-detection/retry-once decision, extracted so it's unit-testable without importing the CLI entry point.
  [`mcp-bridge-resilience.ts:28`](../../src/cli/mcp-bridge-resilience.ts#L28)

**Unbounded worker timeout**

- Timer only scheduled for a finite, positive, 32-bit-safe cap; unset means no cap.
  [`orchestrator/index.ts:450`](../../src/orchestrator/index.ts#L450)

- Config surface: `runTimeoutMs` is optional and validated as a positive integer.
  [`daemon/index.ts:16`](../../src/daemon/index.ts#L16)

**Peripherals**

- Real end-to-end proof: stops and restarts a real daemon mid-session and confirms the same bridge/client recovers transparently.
  [`cli-mcp-bridge.test.ts:134`](../../test/cli-mcp-bridge.test.ts#L134)

- Unit coverage for the 404-recovery decision, including the concurrent-failure dedup guard.
  [`mcp-bridge-resilience.test.ts:16`](../../test/mcp-bridge-resilience.test.ts#L16)

- Orchestrator timeout behavior: unbounded by default, still fires correctly when explicitly capped.
  [`orchestrator-timeout.test.ts:21`](../../test/orchestrator-timeout.test.ts#L21)
