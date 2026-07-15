# Story 3.6: Watch / Incremental Mode

Status: done

> **Implemented by the orchestrator (not the local model), by explicit decision.** Minimal watch design:
> MCP is request/response and `docs/patterns.md` reserves streaming for the Layer-2 UI, so watch is a
> daemon-side long-lived watcher that caches results for `get_test_status` polling (no push/streaming).

## Story

As an AI agent,
I want a watch mode that re-runs only affected tests as files change,
so that iterative development stays fast.

## Acceptance Criteria

1. **Watch enabled + a test file changes → only affected tests re-run (via `--changed`).** ✅
   (Selection Engine routes an only-test change to those files.)
2. **Non-test source change + coverage tracked → dependent tests via the reverse map, re-run.** ✅
   (Selection Engine maps the source to its tests, unioned with the git static graph.)
3. **Fast-mode toggle disabled → coverage collection runs alongside tests.** ✅
   (`start_watch({fastMode:false})` runs each watch run with `coverage:true`, refreshing the map.)
4. **Interactive latency (NFR1) recorded, not gated.** ✅ (`result.metadata.wallClockMs` per run.)

## What shipped

- **`src/watch/index.ts` — `WatchManager`:** per-project `fs.watch({recursive})` session that
  debounces (300ms), ignores `node_modules/.git/.test-mcp/dist/coverage`, coalesces changes that
  arrive mid-run (single in-flight run + `pending` re-run), and re-runs via
  `Orchestrator.runTests({ mode:"incremental", coverage: !fastMode })` — reusing the whole Story 3.5
  selection pipeline. Caches `state` (idle/running/complete/error), `lastResult`, `lastError`,
  `runsCompleted`. `start` is idempotent; `stop`/`stopAll` close watchers.
- **`src/mcp/server.ts`:** new `start_watch` / `stop_watch` tools; `get_test_status` now returns the
  live `WatchStatus` (the only stateful runner in Phase 1). `watchManager` added to `McpServerDeps`.
- **`src/daemon/index.ts`:** constructs one `WatchManager` (shared across HTTP sessions) and injects it.

## Tests

- `test/watch.test.ts` — real git project + built coverage map: `WatchManager` detects a source edit,
  re-runs only the mapped test (cached for polling), and reports not-watching status / `stop()` no-op
  for unknown projects.
- Tool-inventory assertions in `test/mcp-server.test.ts` and `test/mcp-http.test.ts` updated (8 tools).

## Deferred (Phase 2)

- True push/streaming of watch results (Layer-2 SSE/WebSocket) — agents poll `get_test_status` for now.
- `stopAll()` on daemon shutdown signal (currently watchers close on process exit).

## Dev Agent Record

### Agent Model Used
Orchestrator (Opus) — implemented directly per user decision (`impl_min`).

### Completion Notes
- `pnpm run typecheck`, `pnpm run build`, `pnpm test` green (23 files / 82 tests).
- Epic 3 complete (3.1–3.6 done).

### File List
- src/watch/index.ts (new)
- src/mcp/server.ts (start_watch/stop_watch, get_test_status wired to watch, deps)
- src/daemon/index.ts (WatchManager wiring)
- test/watch.test.ts (new)
- test/mcp-server.test.ts, test/mcp-http.test.ts (tool inventory)
