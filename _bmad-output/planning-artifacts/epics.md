---
stepsCompleted: ['step-01', 'step-02', 'step-03', 'step-04']
inputDocuments:
  - docs/prd.md
  - docs/architecture.md
  - _bmad-output/planning-artifacts/prd/prd-test-server-mcp-2026-07-10/SPEC.md
  - _bmad-output/planning-artifacts/architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md
---

# test-server-mcp - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for test-server-mcp, decomposing the requirements from the PRD and Architecture into implementable stories. No UX design contract exists — the primary consumer is AI agents; the human UI is a Phase-2 convenience layer.

## Requirements Inventory

### Functional Requirements

FR1: Run as a single on-system daemon, enforced as a singleton via lockfile + known port, speaking MCP over Streamable HTTP (with an optional stdio single-project mode).
FR2: Provide a `test-mcp` CLI (`register`/`start`/`stop`/`status`) that auto-boots the singleton daemon locally (skippable in CI via `--no-spawn`) and exits non-zero with a clear message if it cannot boot/reach the daemon.
FR3: Register, list, and unregister projects at runtime scoped by `projectId`; on `register`, validate the vitest/vite config, create `<git-root>/.test-mcp/config.json` (`projectId` = hash of abs path, `stateDir`), and add `.test-mcp/` to `.gitignore` if absent.
FR4: Execute a registered project's tests via `run_tests` (scoped by `projectId`) using the project's OWN Vitest through the `vitest/node` programmatic API, inside a per-project worker subprocess with cwd = project root.
FR5: Return structured JSON results (pass/fail counts, duration, failures) and expose `get_failure_details` for per-failure stack/assertion detail.
FR6: Support dry run — `run_tests({dryRun:true})` returns a `TestPlan` (`planId`, selected files, reasoning, `expiresAt`) without executing; `run_tests({planId})` executes exactly that plan; expired/unknown `planId` returns a `PlanExpired` error.
FR7: Provide `get_test_status` returning idle/running/complete/error, and emit MCP progress notifications during a run.
FR8: Structure output for AI consumption — summary carries failures only, full detail on explicit request, consistent JSON with metadata.
FR9: Git-aware delta selection via Vitest `--changed` (static import graph) as a fast pass.
FR10: Build and persist a source-file → test-file reverse coverage map from runtime V8 coverage (single-pass snapshot-diff), keyed by `projectId`, surviving daemon restarts; update incrementally when specific test files change.
FR11: Measure a setup-only baseline once and subtract it from each test's attribution; record setup-baseline modules as full-suite triggers rather than per-test edges.
FR12: Record any unmeasurable test file (timeout/crash/no coverage) as "unknown deps" and always select it on any relevant change (never silently drop).
FR13: Decide re-runs by unioning coverage-map and git-delta selections; fall back to the full suite for any file unknown to the map.
FR14: Provide watch/incremental mode that re-runs only affected tests on file change.
FR15: Guarantee per-file clean environment via Vitest built-in isolation (`isolate:true`); surface in run metadata when a project disables isolation.
FR16: Persist per-project run history and rehydrate the registered-project set on daemon start.
FR17 (Phase 2): Provide a human web UI over HTTP with real-time push (SSE/WebSocket) for status, manual triggers, and history.

### NonFunctional Requirements

NFR1: Dry-run (plan) latency <5s for typical projects; incremental single-file runs fast enough for interactive dev (<15s aspirational target).
NFR2: Correctness/recall prioritised over precision — whenever selection is uncertain (unknown/new file, setup-baseline module, unmeasurable test) run the full suite; no actual failure missed due to intelligent skipping.
NFR3: Security — daemon binds `127.0.0.1` only, performs mandatory Host/Origin validation, and requires a per-daemon bearer token (CLI-managed, never logged).
NFR4: Execution isolation — the daemon process never imports a project's Vitest; two projects on different Vitest versions run without cross-contamination.
NFR5: State transparency & durability — per-project state git-ignored in `<git-root>/.test-mcp/`; daemon-global registry/lockfile central in `~/.test-mcp/`; every persisted JSON carries `schemaVersion`.
NFR6: macOS first (Phase 1); Linux/Windows in Phase 2.
NFR7: Minimal overhead added to a project's test runs.
NFR8: Reverse coverage map buildable within one full instrumented (single-pass) run; naive per-file measurement (~6× slower, per spike) is out.

### Additional Requirements

- No starter template — greenfield TypeScript/Node 20+ project; Epic 1 Story 1 stands up the project scaffold itself.
- MCP SDK: official `@modelcontextprotocol/sdk` v1 (`McpServer`, `StreamableHTTPServerTransport`); v2 is beta and out of scope.
- Vitest access via `vitest/node` (`startVitest`/`createVitest`); pin the version (advanced API differs 3.x↔4.x; target repo pins 4.1.9).
- Per-project workers via `child_process.fork`; daemon↔worker over IPC.
- Standardized error envelope `{code, message, details?}`; UUID v4 for IDs except `projectId` (path hash).
- Coverage engine is single-pass (serial snapshot-diff), validated by `docs/coverage-spike-findings.md` against a large frontend app. The attribution algorithm is ported/vendored from `testpick` (MIT) into the worker; retain its license notice. Differentiator is the daemon/isolation delivery, not coverage selection (table-stakes).

### UX Design Requirements

None — no UX design contract (agent-facing product; Phase-2 UI deferred).

### FR Coverage Map

FR1: Epic 1 — singleton daemon over Streamable HTTP
FR2: Epic 1 — test-mcp CLI + auto-boot
FR3: Epic 1 — register/list/unregister + repo-local config/gitignore
FR4: Epic 2 — run_tests via project-local Vitest in per-project worker
FR5: Epic 2 — structured results + get_failure_details
FR6: Epic 4 — dry-run plan/commit (planId)
FR7: Epic 4 — get_test_status + progress notifications
FR8: Epic 4 — minimal failure-focused JSON output
FR9: Epic 3 — git-delta selection via Vitest --changed
FR10: Epic 3 — coverage reverse-map build/persist
FR11: Epic 3 — setup-baseline subtraction
FR12: Epic 3 — always-run unmeasurable tests
FR13: Epic 3 — union selection + full-suite fallback
FR14: Epic 3 — watch/incremental mode
FR15: Epic 2 — Vitest built-in isolation + metadata
FR16: Epic 1 — per-project history + rehydrate on start
FR17: Epic 5 (Phase 2) — human web UI with real-time push

NFR coverage: NFR3/NFR5/NFR6 → Epic 1; NFR4/NFR7 → Epic 2; NFR2/NFR8 → Epic 3; NFR1 → Epic 4.

## Epic List

### Epic 1: Core Daemon & Project Registration (Phase 1)
Stand up the always-on singleton daemon and let an AI agent register, list, and unregister any vitest/vite project by `projectId` — so from then on all test activity is addressable through MCP instead of shelling out to `vitest`. Delivers a usable, secure, restart-durable multi-project daemon end-to-end (even before intelligent selection exists).
**FRs covered:** FR1, FR2, FR3, FR16 (NFR3, NFR5, NFR6)

### Epic 2: Test Execution via Project-Local Vitest (Phase 1)
Let an agent actually run a registered project's tests and get trustworthy structured results — executed in an isolated per-project worker using the project's *own* Vitest, with per-file isolation and per-failure detail on request.
**FRs covered:** FR4, FR5, FR15 (NFR4, NFR7)

### Epic 3: Intelligent Test Selection (Phase 1)
Turn full-suite runs into affected-only runs without missing failures: git-delta fast pass, a runtime-coverage reverse map with setup-baseline subtraction, always-run for unmeasurable tests, union selection with conservative full-suite fallback, and watch/incremental mode. This is the differentiator.
**FRs covered:** FR9, FR10, FR11, FR12, FR13, FR14 (NFR2, NFR8)

### Epic 4: Agent Workflow — Dry Run, Output & Status (Phase 1)
Give agents the interaction loop they need: plan before committing (dry-run `planId`), poll status with progress, and consume minimal failure-focused JSON output.
**FRs covered:** FR6, FR7, FR8 (NFR1)

### Epic 5: Human Monitoring UI (Phase 2)
A convenience web UI over the daemon for human developers — visual status, manual triggers, history, and genuine real-time push (SSE/WebSocket). Deferred to Phase 2; adds nothing the MCP doesn't already expose.
**FRs covered:** FR17

## Epic 1: Core Daemon & Project Registration (Phase 1)

Stand up the always-on singleton daemon and let an AI agent register/list/unregister any vitest project by `projectId`, securely and durably across restarts. (FR1, FR2, FR3, FR16; NFR3, NFR5, NFR6)

### Story 1.1: Singleton Daemon Lifecycle & CLI

As an AI agent (via the developer's toolchain),
I want a single always-on daemon I can start, stop, and inspect,
So that exactly one instance manages all projects and I never race competing servers.

**Acceptance Criteria:**

**Given** the daemon is installed and not running
**When** `test-mcp start` is invoked
**Then** it reads/validates server config (port, central state dir), writes `~/.test-mcp/daemon.lock` with pid/port, and listens on `127.0.0.1`.

**Given** a daemon is already running
**When** `test-mcp start` is invoked again
**Then** no second instance starts; it reports the running instance's pid/port (singleton enforced via lockfile + known port).

**Given** a running daemon
**When** `test-mcp status` or `test-mcp stop` is invoked
**Then** `status` reports pid/port/registered projects, and `stop` shuts down cleanly and removes the lockfile.

**Given** a stale lockfile whose pid is dead
**When** `test-mcp start` runs
**Then** it detects the dead pid, reclaims the lockfile, and starts normally.

### Story 1.2: MCP Server over Streamable HTTP (secured)

As an AI agent,
I want to connect to the daemon over MCP and discover its tools,
So that I can drive test activity through a validated, secure interface.

**Acceptance Criteria:**

**Given** the daemon is running
**When** a client connects over Streamable HTTP (stateful session) — or stdio in single-project mode
**Then** the server advertises its test tools per the MCP spec.

**Given** an incoming request
**When** its `Host`/`Origin` is not an allowed loopback value, or its bearer token is missing/invalid
**Then** the server rejects it before any tool executes.

**Given** a tool call with bad params or an unknown `projectId`
**When** validation fails
**Then** the server returns a structured error envelope `{code, message, details?}` and runs nothing.

### Story 1.3: Project Registration via `test-mcp register`

As an AI agent,
I want to register a project (auto-booting the daemon if needed) and later list/unregister it,
So that one daemon can serve many projects addressed by `projectId`.

**Acceptance Criteria:**

**Given** a project directory with no `.test-mcp/`
**When** `test-mcp register` is run
**Then** it creates `<git-root>/.test-mcp/config.json` (`projectId` = hash of the absolute path, `stateDir`) and adds `.test-mcp/` to the repo's `.gitignore` if absent.

**Given** the daemon is not running
**When** `test-mcp register` is run locally (without `--no-spawn`)
**Then** it auto-boots the singleton, waits for readiness, then registers; if it cannot boot/reach the daemon it exits non-zero with a message telling the user to start it.

**Given** a directory containing a valid vitest/vite config
**When** `register_project` is invoked (CLI or MCP)
**Then** the server validates the config, uses the config's `projectId`, persists it in the central registry, and returns the registration.

**Given** a path with no resolvable vitest/vite config
**When** `register_project` is called
**Then** the server returns a validation error and does not register the project.

**Given** one or more registered projects
**When** the agent calls `list_projects` / `unregister_project`
**Then** `list_projects` returns each `projectId`, path, and last-known status; `unregister_project` removes it from the active registry (project `.test-mcp/` state retained unless a purge flag is set).

### Story 1.4: Registry Persistence & Rehydration

As an AI agent,
I want registered projects to survive daemon restarts,
So that intelligence and registrations accumulate across sessions.

**Acceptance Criteria:**

**Given** projects were registered
**When** the daemon restarts
**Then** it rehydrates the registered-project set from `~/.test-mcp/registry.json`.

**Given** any persisted registry/config file
**When** it is written
**Then** it carries a `schemaVersion` field.

**Given** a registry file from an older `schemaVersion`
**When** the daemon loads it
**Then** it migrates or reports a clear, non-crashing error.

## Epic 2: Test Execution via Project-Local Vitest (Phase 1)

Run a registered project's tests in an isolated per-project worker using the project's own Vitest, returning trustworthy structured results. (FR4, FR5, FR15; NFR4, NFR7)

### Story 2.1: Run Tests via Project-Local Worker

As an AI agent,
I want `run_tests` to execute a project's suite using that project's own Vitest,
So that results reflect the project's real config/version, not the daemon's.

**Acceptance Criteria:**

**Given** a registered project
**When** `run_tests({projectId})` is called
**Then** the daemon forks a worker with cwd = project root that resolves `vitest/node` from the *project's* `node_modules` and executes via the programmatic API (not CLI parsing).

**Given** two projects on different Vitest versions
**When** both run
**Then** each uses its own installed Vitest without contaminating the daemon process or each other.

**Given** a worker crashes or fails to resolve `vitest/node`
**When** the run is attempted
**Then** the daemon returns a structured error for that `projectId` and stays healthy for other projects.

### Story 2.2: Structured Results & Failure Detail

As an AI agent,
I want compact structured results plus on-demand failure detail,
So that I can react quickly without parsing verbose logs.

**Acceptance Criteria:**

**Given** a completed run
**When** results are returned
**Then** they include pass/fail counts, duration, and failure entries, read from `state.getTestModules()`, as consistent JSON with metadata.

**Given** a failing test
**When** the agent calls `get_failure_details`
**Then** the server returns that failure's stack trace and assertion message.

### Story 2.3: Test Isolation Verification

As an AI agent,
I want per-file environment isolation,
So that cross-file state leakage doesn't produce false results.

**Acceptance Criteria:**

**Given** a suite runs with `isolate: true` (Vitest default)
**When** it executes
**Then** each test file runs in a fresh module/environment context.

**Given** a project explicitly disables isolation for speed
**When** the server runs it
**Then** the run metadata surfaces that isolation is off.

## Epic 3: Intelligent Test Selection (Phase 1)

Turn full-suite runs into affected-only runs without missing failures. This is the differentiator. (FR9–FR14; NFR2, NFR8)

### Story 3.1: Git-Aware Delta Selection

As an AI agent,
I want a fast git-based candidate selection,
So that obvious change sets are picked without building coverage.

**Acceptance Criteria:**

**Given** a git diff against the base
**When** an incremental run is requested
**Then** Vitest `--changed` selects test files affected via the static import graph.

**Given** a changed file not represented in the map
**When** selection runs
**Then** the system falls back to the full suite (no silent skip).

### Story 3.2: Coverage Reverse-Map Build & Persist

As an AI agent,
I want a persisted source→test reverse map,
So that a source edit resolves to the tests that exercise it.

**Acceptance Criteria:**

**Given** no coverage map exists
**When** a full run executes with V8 coverage (single-pass, serial snapshot-diff; attribution algorithm vendored from `testpick`, MIT, adapted to run inside the per-project worker)
**Then** a source-file → test-file map is generated and persisted keyed by `projectId`, surviving restarts.

**Given** the vendored `testpick` (MIT) attribution code is included
**When** the package is built/released
**Then** testpick's copyright + MIT license text is retained (`NOTICE`/`THIRD_PARTY_LICENSES` + a header on the vendored module).

**Given** a coverage map exists and specific test files changed
**When** the run completes
**Then** only those files are re-measured and the map is updated incrementally.

### Story 3.3: Setup-Baseline Subtraction

As an AI agent,
I want setup-file pollution removed from the map,
So that common modules don't make every source look globally depended-on.

**Acceptance Criteria:**

**Given** `setupFiles` run before every test
**When** the map is built
**Then** a setup-only baseline is measured once and subtracted from each test's attribution.

**Given** a module only reached via the setup baseline
**When** it changes
**Then** it is treated as a full-suite trigger, not a per-test edge.

### Story 3.4: Always-Run Unmeasurable Tests

As an AI agent,
I want unmeasurable tests never silently dropped,
So that heavy/crashing tests can't hide failures.

**Acceptance Criteria:**

**Given** a test file cannot be measured (timeout/crash/no coverage — e.g. heavy AG-Grid tests)
**When** the map is built
**Then** it is recorded as "unknown deps" and always selected on any relevant change.

### Story 3.5: Smart Re-run Decision (Union + Fallback)

As an AI agent,
I want re-run decisions that combine both selection signals conservatively,
So that I re-run the minimum safe set.

**Acceptance Criteria:**

**Given** only test files changed
**When** the change occurs
**Then** only those specific test files re-run.

**Given** source files changed
**When** selection runs
**Then** dependent tests re-run based on the union of coverage-map and static-graph selection.

**Given** a changed file unknown to the map
**When** requested
**Then** the system conservatively runs the full suite rather than risk a missed failure.

### Story 3.6: Watch / Incremental Mode

As an AI agent,
I want a watch mode that re-runs only affected tests as files change,
So that iterative development stays fast.

**Acceptance Criteria:**

**Given** watch mode is enabled
**When** a test file changes
**Then** only affected tests re-run (via `--changed`).

**Given** a non-test source file changes and coverage is tracked
**When** the change occurs
**Then** the system determines dependent tests via the reverse map and re-runs them.

**Given** a fast-mode toggle is disabled
**When** a run occurs
**Then** coverage collection runs alongside tests.

## Epic 4: Agent Workflow — Dry Run, Output & Status (Phase 1)

Give agents the interaction loop: plan before committing, poll status/progress, and consume minimal failure-focused output. (FR6, FR7, FR8; NFR1)

### Story 4.1: Dry-Run Plan / Commit

As an AI agent,
I want to compute a plan and inspect it before executing,
So that I never run tests I didn't intend to.

**Acceptance Criteria:**

**Given** `run_tests({projectId, dryRun:true})`
**When** the plan is computed
**Then** the server returns a `TestPlan` (`planId`, selected files, reasoning, `expiresAt`) without executing.

**Given** a valid, unexpired `planId`
**When** the agent calls `run_tests({projectId, planId})`
**Then** the server executes exactly the planned files and returns a `TestResult`.

**Given** an expired or unknown `planId`
**When** commit is attempted
**Then** the server returns a `PlanExpired` error and the agent re-plans.

### Story 4.2: Status & Progress

As an AI agent,
I want to poll run state and receive progress,
So that I can coordinate long runs without blocking.

**Acceptance Criteria:**

**Given** a run in progress
**When** the agent calls `get_test_status`
**Then** the server returns idle/running/complete/error and emits `notifications/progress` during the run.

**Given** a completed or errored run
**When** status is queried
**Then** the server returns the final results, or the error details, respectively.

### Story 4.3: Minimal Failure-Focused Output

As an AI agent,
I want summaries that foreground failures,
So that I spend tokens only on what broke.

**Acceptance Criteria:**

**Given** tests run
**When** the summary is generated
**Then** it includes counts and failures only, with full detail available via `get_failure_details`.

**Given** results are returned
**When** consumed
**Then** the format is consistent JSON with metadata.

## Epic 5: Human Monitoring UI (Phase 2)

A convenience web UI over the daemon: visual status, manual triggers, history, and genuine real-time push. Deferred to Phase 2. (FR17)

### Story 5.1: HTTP Status UI

As a human developer,
I want a web page showing live test status,
So that I get visibility without the CLI.

**Acceptance Criteria:**

**Given** the daemon is running with the UI port configured
**When** the UI page is loaded
**Then** it displays current test status for registered projects.

**Given** tests are running
**When** new events occur
**Then** the UI updates without a manual refresh (WebSocket or SSE).

### Story 5.2: Real-time Updates & Resilience

As a human developer,
I want live streaming results that survive reconnects,
So that the view stays accurate during long runs.

**Acceptance Criteria:**

**Given** tests are running
**When** a test completes
**Then** the UI receives the result immediately and remains responsive under load.

**Given** the connection drops
**When** it reconnects
**Then** the UI shows the latest known state.
