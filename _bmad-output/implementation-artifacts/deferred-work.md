# Deferred Work Ledger

## Deferred from: code review of story-2-1-run-tests-via-project-local-worker.md (2026-07-14)

- `maxConcurrentWorkers` not wired to Orchestrator — architecture gap; story 2.1 defers pooling/lifecycle
- `configPath` not forwarded to worker — story relies on Vitest cwd auto-discovery
- Full daemon `process.env` inherited in fork — pre-existing env-inheritance pattern
- SIGTERM-only kill on timeout — hung workers may survive SIGTERM
- Worker error `stack` discarded before MCP — observability gap
- `mapModulesToResult` lacks direct unit tests — integration tests cover happy path only
- No `disconnect` IPC handler — timeout is fallback
- Serialization test is sequential not concurrent — promise-chain serialization structurally sound; concurrent stress not required by spec

## Deferred from: code review of story-2-2-structured-results-failure-detail.md (2026-07-14)

- Duplicate `${moduleId}::collect` ids collapse in orchestrator Map — pre-existing Story 2.1 id scheme; Story 2.2 correctly mirrors it
- `get_failure_details` during in-flight `run_tests` returns prior run's cache — Phase 1 in-memory semantics; lookups not queued with runs
- Unregister does not evict `lastFailures` entries — same pattern as `queues`; out of Story 2.2 scope
