---
name: 'test-server-mcp'
type: spec
purpose: requirements-contract
altitude: feature
status: final
created: '2026-07-10'
updated: '2026-07-16'
binds: []
sources: ['../../../../docs/prd.md']
companions: ['../../architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md', '../../architecture/architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md']
---

# SPEC — test-server-mcp

## Intent

A **single on-system daemon** that AI agents talk to instead of invoking `vitest`
directly. An agent registers a project (any dir with a vitest/vite config), then drives
intelligent test orchestration through MCP tools scoped by `projectId`. One daemon serves
many projects; each project's tests run under its *own* Vitest, and per-project
intelligence (coverage map, history) persists so feedback gets faster over time. Primary
consumer is AI agents; a Phase-2 web UI serves humans.

**Positioning (2026-07-10):** coverage-based test selection is now table-stakes — shipping
tools already do it (`testpick`, `vitest-agent`, `vitest-affected`; a native `vitest
--stale` is proposed). The differentiator is the **delivery architecture**: one always-on
multi-project daemon, project-local Vitest **version isolation**, **transparent repo-local
state**, and setup-baseline subtraction as first-class correctness. This is a feature wedge,
not a durable moat; we compete on execution and recall-first correctness. The coverage
attribution algorithm is **vendored from `testpick` (MIT)** into our worker rather than
wrapped (it's a CLI that owns the run) or rebuilt from scratch.

## Capabilities

| ID | Capability | Intent (WHAT) | Success signal |
| --- | --- | --- | --- |
| C1 | Dry run (plan/commit) | Let agents evaluate a plan before executing | `dryRun` returns a `TestPlan` (`planId`, files, reasoning, `expiresAt`); `run_tests({planId})` executes exactly that; expired → re-plan |
| C2 | Run tests programmatically | Execute a project's tests via MCP | `run_tests({projectId,…})` returns structured pass/fail/duration/failures |
| C3 | Intelligent incremental runs | Re-run only affected tests | On a source change, the selected set is materially smaller than full suite while missing no real failure |
| C4 | Progress + status (reframed) | Coarse live status without protocol push streaming | `get_test_status` → idle/running/complete/error; `notifications/progress` emitted during a run. (Real-time push deferred to C-UI/Phase 2.) |
| C5 | Minimal failure-focused output | Structure output for AI consumption | Summary carries counts + failures only; full stack/assertion via `get_failure_details` |
| C6 | Status monitoring | Expose run state to agents/CI | Status queryable per project at any time |
| C7 | Runtime project registration | One daemon serves many projects | `register_project`/`list_projects`/`unregister_project`; `test-mcp register` auto-boots the singleton and registers a config-valid project |
| C8 | Project-local execution | Honour each project's own Vitest | Tests run in a per-project worker subprocess (cwd = project root) resolving `vitest/node` from the project; two projects on different Vitest versions don't clash |
| C9 | Coverage reverse-map | Map source→test-file for smart selection | Built single-pass from runtime V8 coverage (attribution algorithm vendored from `testpick`, MIT), with setup-baseline subtracted and unmeasurable tests always-run |
| C10 | Runner plugin interface | Extract Vitest behind a `RunnerPlugin` interface, Vitest as first implementation | `RunnerPlugin` interface (name, detect, capabilities, listTestFiles, run, affectedTests?, readCoverageThresholds?); Vitest extraction is zero-behavior-change (existing test suite passes unmodified) |
| C11 | Multi-suite registration | Register more than one test surface per project (e.g. unit + e2e), each its own plugin | `RegisteredProject.suites: Record<suiteName, {configPath, plugin}>`; `test-mcp register` auto-detects via each plugin's `detect()`, explicit `--suite` override when it can't resolve |
| C12 | Per-suite scoping + graded coverage confidence | Selection/coverage/confidence/orchestrator bookkeeping never cross suite boundaries; a suite without coverage is a defined state | `Confidence` gains a third `"unavailable"` level (extends `high`/`degraded`) for a suite whose plugin reports `capabilities.coverage === "none"`; `thresholdsMet` never falsely asserted |
| C13 | Jest plugin (seam validation) | Prove the `RunnerPlugin` interface holds for a second real runner | Jest plugin implements run/listTestFiles/detect/changedFileDetection at seam-validation scope (not full parity); passes an equivalent hermetic test suite to the Vitest plugin's |

## Constraints

- **Single daemon per system** over Streamable HTTP (`StreamableHTTPServerTransport`, stateful sessions), enforced by lockfile + known port; optional stdio single-project mode. `@modelcontextprotocol/sdk` v1 (`McpServer`).
- **Project-local execution**: daemon never imports a project's test runner, of any kind (generalized 2026-07-16 from "Vitest" — see Epic 7); per-project worker subprocess resolves the suite's runner from the project via its bound `RunnerPlugin`. Pin Vitest version (target repo 4.1.9) within the Vitest plugin specifically.
- **State layout**: per-project state (coverage map + history) in git-ignored `<git-root>/.test-mcp/`; daemon-global registry/lockfile central (`~/.test-mcp`), never inside a project. `projectId` = hash of abs path, pinnable.
- **Coverage engine**: single-pass V8 snapshot-diff mapping; subtract the setup-file baseline (setup-loaded modules are full-suite triggers); any unmeasurable test is always-run. (Spike-validated on a large frontend app.)
- **Correctness over cleverness**: recall prioritised — whenever selection is uncertain (unknown file, setup-baseline module, unmeasurable test) run the full suite.
- **Security**: bind `127.0.0.1` only; mandatory Host/Origin validation; per-daemon bearer token (CLI-managed).
- **Versioned schemas**: every persisted JSON carries `schemaVersion`.
- **Third-party attribution**: retain `testpick`'s MIT copyright + license text for the vendored attribution module (`NOTICE`/`THIRD_PARTY_LICENSES` + module header); track upstream.

## Non-goals

- ~~Jest / pytest support (future).~~ **Jest now in progress (Epic 7, seam-validation scope only — C10-C13); pytest and any other non-JS runner remain future.** A generic shell-command/Docker plugin escape hatch, a universal cross-runner coverage merge format, and function-level selection granularity are also explicitly out of scope for Epic 7.
- Human web UI (Phase 2); genuine real-time SSE/WebSocket push lives there, not on MCP stdio.
- Priority scoring + test health monitoring (Phase 2).
- Fixture/setup-time cost tracking, ordering-dependency detection, parallel resource-contention quotas (deferred, research-grade).
- Cross-platform beyond macOS (Linux/Windows Phase 2); distributed caching.

## Success signal

- Dry-run (plan) latency <5s for typical projects; incremental single-file runs fast enough for interactive dev (<15s target).
- Coverage reverse-map buildable within one full instrumented (single-pass) run.
- After setup-baseline subtraction, a source change selects a small fraction of the suite — spike measured ~6% (unit-file changes) and ~18% (integration-file changes) on the target repo.
- No actual failures missed due to intelligent skipping, guaranteed by conservative full-suite fallback rather than an absolute precision claim.

## Deferred

- Multi-project is now core (was deferred); remaining deferrals under Non-goals.
- Advanced caching strategies (distributed cache), CI/CD-specific optimizations, detailed error-recovery strategies.
