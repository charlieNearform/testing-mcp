# Brainstorm Intent: MCP Test Runner Features

## Session Goal
Flesh out feature set and sanity check the existing PRD for an intelligent test runner MCP server.

## Critical Decisions

### Performance Philosophy
- Minimize feedback cycles through intelligent test selection
- Only re-run tests that are affected by code changes
- Keep incremental runs fast enough for interactive development
- Accuracy matters more than raw speed - better to be conservative than miss failures

### Technical Constraints
- Vitest API verification — DONE (July 2026): use `vitest/node` `startVitest`/`createVitest`; per-test coverage attribution must be built from runtime coverage (not available from a standard report); `--changed` is static-import-graph only
- Coverage tracking: optional toggle, enabled by default
- Start with macOS, add cross-platform later
- Runs as a persistent on-system daemon over Streamable HTTP; AI registers projects at runtime and drives runs via MCP (not `vitest` CLI). Optional stdio single-project mode. UI adds its own SSE/WebSocket push in Phase 2.

### UX Principles
- Dry run mode: queue tests without executing, let AI iterate before committing to run
- Priority override mechanism for manual control
- CI-First mode toggle, disabled by default for local dev

## Feature Priorities (MoSCoW)

> Reconciled after feasibility research. Authoritative phasing is `docs/prd.md#phasing`.
> The original session put fixture/ordering/resource-contention in MUST; feasibility
> review reclassified those as research-grade (deferred), and pulled dry run + delta +
> progressive disclosure into Phase 1 since they are cheap and central to the AI workflow.

### MUST Have (Phase 1)
- Core MCP infrastructure: single on-system daemon (`McpServer` + Streamable HTTP) with runtime project registration via a thin `test-mcp` CLI (auto-boots the singleton); per-project state in git-ignored `.test-mcp/`, daemon registry central
- Vitest integration via the `vitest/node` programmatic API, executed in per-project worker subprocesses using project-local Vitest
- Test isolation via Vitest's built-in isolation
- Git-aware delta selection (Vitest `--changed`, static graph)
- Coverage-based reverse-dependency mapping (built from runtime coverage — the differentiator)
- Dry run mode: queue tests without executing, run after iteration complete
- Progressive disclosure output format

### SHOULD Have (Phase 2)
- Priority scoring (git recency, failure history)
- Basic health dashboard
- Smart retry logic with isolation
- Human UI with real-time (SSE/WebSocket) updates
- Cross-platform support

### COULD Have (Phase 3 / deferred)
- Advanced dependency graph visualization
- Priority-based sharding
- IDE integration
- Trend analytics
- Suggested fixes for common failures
- Research-grade: fixture/setup-time tracking, ordering-dependency detection, parallel resource-contention quotas

## Gaps Addressed
1. Test isolation - covered by Vitest's built-in isolation (Phase 1)
2. Fixture/setuptime tracking - deferred (research-grade; not needed to prove the core selection engine)
3. Ordering dependencies detection - deferred (research-grade)
4. Parallel resource contention quotas - deferred (research-grade)
5. AI agent workflow - dry run mode allows queuing tests during iteration, running only after iteration completes (Phase 1)

## Next Steps
This intent doc can feed directly into `bmad-product-brief` or `bmad-prd`.
