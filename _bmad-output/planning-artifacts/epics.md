---
stepsCompleted: ['step-01', 'step-02', 'step-03', 'step-04']
inputDocuments:
  - docs/prd.md
  - docs/architecture.md
  - _bmad-output/planning-artifacts/prd/prd-test-server-mcp-2026-07-10/SPEC.md
  - _bmad-output/planning-artifacts/architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/briefs/brief-test-server-mcp-2026-07-16/brief.md
  - _bmad-output/planning-artifacts/architecture/architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/architecture/architecture-epic-8-async-execution-observability-2026-07-17/ARCHITECTURE-SPINE.md
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
FR18: Provide a `RunnerPlugin` interface (`name`, `detect`, `capabilities`, `listTestFiles`, `run`, `affectedTests`?, `readCoverageThresholds`?) behind which all runner-specific logic is extracted; Vitest becomes the first implementation with zero behavior change.
FR19: Support registering one or more named test suites per project, each bound to one `RunnerPlugin` instance; `test-mcp register` auto-detects suites via each plugin's `detect()` with an explicit override for cases auto-detect can't resolve.
FR20: Scope test selection, the coverage map, combined coverage, confidence, run history, and failure-detail lookup per suite (not just per project); confidence gains a third "unavailable" level for suites whose plugin reports no coverage capability.
FR21: Provide a Jest `RunnerPlugin` (seam-validation scope) implementing run/listTestFiles/detect and changed-file detection via Jest's own flags, with coverage capability graded, not assumed.
FR22: `run_tests` returns the full result synchronously if it finishes within a configurable grace period (`waitMs`: per-call → project config → daemon config → 10s built-in default; explicit `null` at any layer = wait forever); otherwise it returns `{runId, projectId, state:"running"}` and the caller polls `get_test_status`, extending the same pattern already documented for `start_watch`.
FR23: While a run is in flight, `get_test_status` and the human UI expose a live, bounded per-test list (pending/running/passed/failed/skipped) via Vitest's optional `onTestCaseReady`/`onTestCaseResult` reporter hooks (Vitest 3+; gracefully degrades to today's file-level-only granularity when a project's Vitest predates these hooks).
FR24: The daemon captures a run's worker stdout+stderr into a bounded (1000-line) per-project ring buffer, exposed via the UI with a "follow" mode, while stderr is still forwarded to the daemon's own stderr unchanged.
FR25: A stall watchdog, on by default, kills a worker if there has been no test-level progress signal for `testTimeout + grace` (grace configurable, default 5s), reusing the existing whole-run-timeout kill path; a coverage-measurement-phase heartbeat prevents false positives during that otherwise-silent phase.

### NonFunctional Requirements

NFR1: Dry-run (plan) latency <5s for typical projects; incremental single-file runs fast enough for interactive dev (<15s aspirational target).
NFR2: Correctness/recall prioritised over precision — whenever selection is uncertain (unknown/new file, setup-baseline module, unmeasurable test) run the full suite; no actual failure missed due to intelligent skipping.
NFR3: Security — daemon binds `127.0.0.1` only, performs mandatory Host/Origin validation, and requires a per-daemon bearer token (CLI-managed, never logged).
NFR4: Execution isolation — the daemon process never imports a project's Vitest; two projects on different Vitest versions run without cross-contamination.
NFR5: State transparency & durability — per-project state git-ignored in `<git-root>/.test-mcp/`; daemon-global registry/lockfile central in `~/.test-mcp/`; every persisted JSON carries `schemaVersion`.
NFR6: macOS first (Phase 1); Linux/Windows in Phase 2.
NFR7: Minimal overhead added to a project's test runs.
NFR8: Reverse coverage map buildable within one full instrumented (single-pass) run; naive per-file measurement (~6× slower, per spike) is out.
NFR9: Runner plugin isolation — the daemon process never imports a project's test runner directly, of any kind (generalizes NFR4); only the owning plugin module resolves the runner package.
NFR10: No coverage capability is a defined, reportable state, not an error — the daemon must never assert a confidence level or threshold verdict a plugin's declared capability can't back.
NFR11: Reliability — a genuinely wedged worker is detected and killed automatically (stall watchdog, on by default) rather than hanging indefinitely; a long run never holds an MCP tool call open past its configured grace period, so the client's own request-timeout behavior is never the limiting factor for a run that completes within that window.

### Additional Requirements

- No starter template — greenfield TypeScript/Node 20+ project; **Epic 1 Story 1.0** stands up the project scaffold per `docs/scaffold-spec.md` (literal file tree, pinned deps, stub modules). Story 1.1+ add behaviour on top — do not relocate paths.
- MCP SDK: official `@modelcontextprotocol/sdk` v1 (`McpServer`, `StreamableHTTPServerTransport`); v2 is beta and out of scope.
- Vitest access via `vitest/node` (`startVitest`/`createVitest`); pin the version (advanced API differs 3.x↔4.x; target repo pins 4.1.9).
- Per-project workers via `child_process.fork`; daemon↔worker over IPC.
- Standardized error envelope `{code, message, details?}`; UUID v4 for IDs except `projectId` (path hash).
- Coverage engine is single-pass (serial snapshot-diff), validated by `docs/coverage-spike-findings.md` against a large frontend app. The attribution algorithm is ported/vendored from `testpick` (MIT) into the worker; retain its license notice. Differentiator is the daemon/isolation delivery, not coverage selection (table-stakes).
- Jest's embeddable run API is an open engineering question (`runCLI` from `@jest/core` vs. plain `jest`'s exiting `run()`) — Story 7.5 spikes this before Story 7.6 writes `run()`; escalate per this repo's dependency-authorization rule if `@jest/core` isn't reliably resolvable.
- `istanbul-lib-coverage` (already pinned, Story 6.10) covers Jest's coverage parsing too — no new runtime dependency needed for Story 7.6's coverage capability.
- Vitest's `onTestCaseReady`/`onTestCaseResult` reporter hooks (Story 8.2) are Vitest 3+ only and optional — a project's older Vitest simply never calls them; no version bump, no new dependency, verified directly against the installed Vitest 4.1.9 type definitions.
- `fork()`'s `stdio` option (Story 8.5) moves from `["ignore","ignore","inherit","ipc"]` to `["ignore","pipe","pipe","ipc"]` — standard Node `child_process` API, no new dependency.

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
FR18: Epic 7 — RunnerPlugin interface + Vitest extraction (zero behavior change)
FR19: Epic 7 — multi-suite registry model
FR20: Epic 7 — per-suite selection/coverage/confidence/orchestrator/MCP scoping
FR21: Epic 7 — Jest plugin (seam validation)
FR22: Epic 8 — async `run_tests` with configurable grace period
FR23: Epic 8 — live per-test progress
FR24: Epic 8 — console log tail with follow
FR25: Epic 8 — stall watchdog (on by default)

NFR coverage: NFR3/NFR5/NFR6 → Epic 1; NFR4/NFR7 → Epic 2; NFR2/NFR8 → Epic 3; NFR1 → Epic 4; NFR9/NFR10 → Epic 7; NFR11 → Epic 8.

Performance NFR acceptance criteria: NFR1 → Story 4.1 (dry-run plan <5s target) and Story 3.6 (incremental single-file run <15s, aspirational per PRD Success Metrics); NFR7 → Story 2.1 (worker/daemon overhead surfaced in run metadata; monitored, not hard-gated).

## Epic List

### Epic 1: Core Daemon & Project Registration (Phase 1)
Stand up the always-on singleton daemon and let an AI agent register, list, and unregister any vitest/vite project by `projectId` — so from then on all test activity is addressable through MCP instead of shelling out to `vitest`. **Story 1.0** creates the greenfield scaffold (`docs/scaffold-spec.md`); stories 1.1–1.4 add daemon, MCP, registration, and persistence.
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

### Epic 6: Post-v1 Enhancements — Onboarding, Hardening & Observability (Phase 2)
Enhancements shipped after the v1 epics closed: smoother agent/human onboarding (CLI config helpers, PATH linking, stable configurable auth), a hardening pass from an adversarial code review, and richer run observability (run history + a drill-down UI). **Story 6.0** is a retrospective as-built record of work that was implemented directly on `main` outside the BMAD cycle; stories 6.1+ resume the normal story → dev → review flow for new observability work.
**FRs covered:** extends FR17; hardening of FR1–FR16 (no new PRD FRs — post-v1 usability/quality)

### Epic 7: Runner Plugin API (Phase 2, continued)
Extract the daemon's hardcoded Vitest integration behind a `RunnerPlugin` interface (fulfilling architecture AD-2's deferred adapter model), add multi-suite-per-project registration, scope selection/coverage/confidence/orchestrator bookkeeping per suite, and add Jest as a second plugin scoped to validating the seam (not full parity). Authoritative invariants: `_bmad-output/planning-artifacts/architecture/architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md` (AD-12–AD-16). Source brief: `_bmad-output/planning-artifacts/briefs/brief-test-server-mcp-2026-07-16/brief.md`.
**FRs covered:** FR18, FR19, FR20, FR21 (NFR9, NFR10)

### Epic 8: Async Execution & Observability (Phase 2, continued)
A long-running `run_tests` call no longer holds one MCP tool call open for its whole duration: it returns the full result if the run finishes within a configurable grace period, otherwise a job handle to poll via `get_test_status` — extending the same kick-off-then-poll pattern already used by `start_watch`. In parallel, an in-flight run becomes observable (live per-test pending/pass/fail list, a bounded console log tail with follow) instead of opaque, and a stall watchdog — on by default — catches a genuinely wedged worker instead of waiting forever. Authoritative invariants: `_bmad-output/planning-artifacts/architecture/architecture-epic-8-async-execution-observability-2026-07-17/ARCHITECTURE-SPINE.md` (AD-17–AD-21).
**FRs covered:** FR22, FR23, FR24, FR25 (NFR11)

## Epic 1: Core Daemon & Project Registration (Phase 1)

Stand up the always-on singleton daemon and let an AI agent register/list/unregister any vitest project by `projectId`, securely and durably across restarts. (FR1, FR2, FR3, FR16; NFR3, NFR5, NFR6)

> **Implementation order:** 1.0 → 1.1 → 1.2 → 1.3 → 1.4. Story 1.0 is a hard prerequisite — do not start 1.1 until 1.0 verification checklist passes.

### Story 1.0: Greenfield Project Scaffold

As a developer (or implementer agent),
I want a compiling TypeScript package with the prescribed directory layout, CLI bin, and stub modules,
So that later stories can add daemon/MCP/registry behaviour without restructuring the repo.

**Authority:** follow `docs/scaffold-spec.md` literally. That document is the copy-paste contract (file tree, `package.json`, `tsconfig.json`, stub exports, tests). This story adds no runtime behaviour beyond `--help` and not-implemented stubs.

**Acceptance Criteria:**

**Given** a clean checkout with no `package.json` / `src/` / `dist/`
**When** the implementer follows `docs/scaffold-spec.md`
**Then** every path in the spec's directory tree exists with the prescribed module boundaries (`cli/`, `daemon/`, `mcp/`, `registry/`, `orchestrator/`, `selection/`, `worker/`, `types/`).

**Given** `pnpm install` has been run
**When** `pnpm run typecheck` and `pnpm run build` are executed
**Then** both exit 0 and `dist/cli/main.js` exists.

**Given** the package is built
**When** `pnpm test` is executed
**Then** all tests in `test/` pass (smoke + CLI `--help` test per spec).

**Given** the CLI is installed locally
**When** `node bin/test-mcp.mjs --help` runs
**Then** stdout lists subcommands `init`, `register`, `start`, `stop`, `status`.

**Given** any runtime subcommand (`start`, `stop`, `status`, `register`)
**When** invoked before Story 1.1+
**Then** it prints a clear `not implemented (Story X.Y)` message and exits non-zero (`init` may exit 0).

**Given** stub modules in `src/daemon/`, `src/mcp/`, `src/registry/`, etc.
**When** imported
**Then** they compile and export the named symbols from the spec; they must **not** bind ports, spawn daemons, or write `~/.test-mcp/` yet.

**Given** `docs/scaffold-spec.md` Hard rules
**When** reviewing the PR
**Then** ESM + Node 20+, pinned dependency versions (no `^`), Vitest only in `devDependencies`, and no extra undeclared dependencies.

**Verification (copy-paste):**
```bash
pnpm install && pnpm run typecheck && pnpm run build && pnpm test
node bin/test-mcp.mjs --help
node bin/test-mcp.mjs start   # expect exit 1 + not-implemented message
```

### Story 1.1: Singleton Daemon Lifecycle & CLI

**Prerequisite:** Story 1.0 complete (`docs/scaffold-spec.md` verification checklist passes).

**Scope:** replace stubs in `src/daemon/index.ts` and wire `src/cli/main.ts` `start`/`stop`/`status` — do **not** rename or move scaffold paths.

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

**Prerequisite:** Story 1.1 complete (daemon starts/stops). Implement in `src/mcp/server.ts` — do not relocate.

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

**Prerequisite:** Story 1.2 complete (MCP server running). Implement in `src/registry/project-registry.ts` + CLI `register`/`init` — do not relocate.

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

**Prerequisite:** Story 1.3 complete. Extend `src/registry/project-registry.ts` — `schemaVersion` on all persisted JSON per architecture.

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

**Given** a run executes via the per-project worker (NFR7 — minimal overhead)
**When** results are returned
**Then** run metadata reports daemon/worker overhead relative to test execution time, keeping added overhead observable and minimal (monitored, not a hard gate).

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

**Given** an incremental single-file change in watch mode (NFR1 — interactive latency)
**When** affected tests re-run
**Then** the run completes fast enough for interactive development (<15s aspirational target per PRD Success Metrics; recorded for tuning, not a hard gate).

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

**Given** a typical project (NFR1 — dry-run latency)
**When** a dry-run plan is computed
**Then** the plan is returned in under 5s; if exceeded, the plan is still returned and the latency is recorded in the plan metadata for tuning.

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

## Epic 6: Post-v1 Enhancements — Onboarding, Hardening & Observability (Phase 2)

Enhancements after the v1 epics closed. Story 6.0 retrospectively records work already shipped directly on `main`; stories 6.1+ are new work to run through the normal story → dev → review cycle.

> **Implementation order:** 6.0 (as-built, done) → **6.4 → 6.5 → 6.6 → 6.7 → 6.8** (selection refinements first) → 6.1 → 6.2 → 6.3 → **6.10**. 6.9 is backlog.
>
> **Course-correction (2026-07-15, ratified):** the selection model was reshaped to
> "select tight + report confidence" (softening invariant 5) — see
> `sprint-change-proposal-2026-07-15.md`. Effects: 6.5 adds a `.test-mcp-ignore`; 6.6's
> modified-unmapped case becomes "select + flag confidence" (not force-full); 6.7 confirms the
> **last-run** default baseline with validated-only snapshot advance + deletion handling; **6.8**
> (confidence signal) and **6.10** (combined incremental coverage) are added. Architecture
> (invariant 5, selection algorithm, data model, tool contract) and PRD (FR13/FR14 ACs) were
> updated to match.

### Story 6.0: Post-v1 Onboarding & Hardening (as-built)

> Retrospective record. Implemented directly on `main` on 2026-07-15 outside the BMAD cycle; captured here so the plan reflects reality. Status: done.

As a maintainer,
I want the post-v1 usability and hardening work recorded as a story,
So that the plan reflects what actually shipped and future work builds on an accurate baseline.

**Acceptance Criteria:**

**Given** a developer cloning the repo
**When** they read the docs and run the CLI
**Then** a usage guide (`docs/usage.md`) and corrected README exist, and the CLI offers `mcp-config`, `ui`, `link`, and `unlink` alongside `init`/`register`/`start`/`stop`/`status`.

**Given** an MCP client needs to authenticate to the daemon
**When** it is configured
**Then** the `/mcp` bearer token is stable across restarts and configurable (persisted `config.token`, `TEST_MCP_TOKEN` override), and `mcp-config` emits two token-safe options (local-scope command, or committed `.mcp.json` with a `headersHelper` reading the daemon's `~/.test-mcp/token`).

**Given** the adversarial code review findings
**When** they are remediated
**Then** the coverage watch self-loop, `link --force` real-file deletion, non-atomic `registry.json` write, missing Zod validation (config/registry/IPC), unbounded worker concurrency, plan-cache leak, malformed-map crash, zero-test-run mislabel, self-closing daemon on transient socket error, and IPv6 Host/Origin parsing are all fixed with tests.

**Given** a human watching the daemon
**When** runs execute
**Then** the `/ui` page live-updates over SSE and supports drill-down (project → run history → run detail) backed by an in-memory run-history store.

### Story 6.1: Per-Passing-Test Detail + Persistent Project Status Banner

As a human (and agent) reviewing a run,
I want to see every test that executed with its pass/fail/skip status (not just failures), and to keep the project's live status in view while browsing its history,
So that a run's detail shows the full picture and the project's current state is always at hand.

**Acceptance Criteria:**

**Given** a run executes N tests
**When** the worker reports the result
**Then** the result carries a per-test list (name, file, status) for all tests that ran — passing, failing, and skipped — not only failures.

**Given** a completed run in history
**When** its detail is requested (UI `/ui/api/projects/:id/runs/:runId`)
**Then** the per-test list is present and the UI run-detail view lists every test grouped/marked by status.

**Given** a large suite
**When** the per-test list is produced
**Then** it stays bounded or summarized so a run record does not grow unboundedly (define a sane cap, or omit passing-test bodies while keeping names/status).

**Given** the project run-history view is open
**When** it renders and as runs progress
**Then** the project's current run state (the same status shown on the root-page card) is pinned as a banner at the top and updates live via SSE.

### Story 6.3: Coverage Report in Run Results & UI

As a human developer,
I want each coverage-enabled run to report its coverage summary and surface it in the UI,
So that I can see overall and per-file coverage and whether a project's coverage gate passed.

**Acceptance Criteria:**

**Given** a run executes with `coverage: true`
**When** the worker reports the result
**Then** the result carries a coverage summary (overall statements/branches/functions/lines percentages, plus per-file), as an additive optional field; a run without coverage omits it.

**Given** a completed coverage run in history
**When** its detail is viewed in the UI
**Then** the coverage report is shown (overall prominently, per-file breakdown) and the overall % is surfaced on the project card / run row.

**Given** the project's own Vitest config enforces coverage thresholds (e.g. 100%)
**When** coverage falls below threshold
**Then** the run surfaces that the coverage gate failed distinctly from ordinary test failures (test-mcp reports the project's thresholds; it does not invent its own).

### Story 6.2: On-Disk Run-History Persistence

As a human developer,
I want run history to survive daemon restarts,
So that I can review past runs after stopping/starting the daemon or rebooting.

**Acceptance Criteria:**

**Given** a run completes
**When** it is recorded
**Then** a schema-versioned per-run record is persisted under `<git-root>/.test-mcp/history/` (git-ignored), in addition to the in-memory buffer.

**Given** the daemon (re)starts
**When** the UI/history endpoints are queried
**Then** history is rehydrated from disk (most-recent-first, capped), so past runs appear after a restart.

**Given** the history grows past the retention cap
**When** new runs are recorded
**Then** the oldest on-disk records are pruned so the directory stays bounded.

### Story 6.4: Surface the Real Selection Reason in Run Results

As an agent/human reading a run,
I want the result's selection reason to state why those tests were chosen (or why the full suite ran),
So that "full suite" no longer masks the actual decision (e.g. a changed file unknown to the map).

**Acceptance Criteria:**

**Given** an incremental run falls back to full because a changed file is unknown to the map
**When** the result is returned
**Then** `selection.reason` states the real cause (e.g. "changed file unknown to coverage map: `<file>`"), not the generic "full suite".

**Given** any selection path (map ∪ git graph, git `--changed`, no-changes, committed plan)
**When** the result is returned
**Then** `selection.reason`/`selection.strategy` reflect the orchestrator's decision, while `selection.files` still lists what actually ran.

### Story 6.5: Don't Full-Suite on Test-Irrelevant File Changes

As a developer using incremental selection,
I want changes to files that can't affect a test run (docs, VCS/editor/agent dotfiles) to be ignored,
So that an unrelated `.gitignore`/`CLAUDE.md`/`*.md` edit doesn't force the whole suite.

**Acceptance Criteria:**

**Given** the only changed files are provably test-irrelevant
**When** an incremental run is planned
**Then** they are excluded from selection input and do not force a full suite (treated as "no relevant changes").

**Given** a changed file that could affect tests (source/test, or build/test config: `package.json`, lockfiles, `*.config.*`, `tsconfig*.json`, setup files)
**When** selection runs
**Then** the conservative full-suite fallback is unchanged (invariant 5 preserved for anything that could matter).

**Given** a mix of ignored and relevant changes
**When** selection runs
**Then** only the relevant changes drive selection.

### Story 6.6: New Source Files Bounded by the Git Static Graph

As a developer adding a new file with its test,
I want a brand-new source file to be bounded by the git `--changed` static graph, not a full suite,
So that "add a feature + its test" runs only the affected tests instead of everything.

**Acceptance Criteria:**

**Given** the only changes are a new (untracked) source file and its new test, with a coverage map present
**When** an incremental run is planned
**Then** the run is bounded by the git `--changed` static-graph selection (the new test plus any existing test that statically imports the new source), not the full suite.

**Given** a modified existing source unknown to the map, a setup-baseline change, an unmeasurable-test trigger, or git/static-graph unavailable
**When** selection runs
**Then** the conservative full-suite fallback still applies (invariant 5 preserved for genuinely unbounded cases).

> Changes documented selection behaviour (step 4 / invariant 5) — reconcile with the architecture spine before implementing (see the story's escalation triggers).

### Story 6.7: "Changed Since Last Run" Incremental Baseline

As a developer iterating edit → run → edit → run,
I want incremental selection to key off "what changed since the last test run", not "since git HEAD",
So that a long uncommitted session doesn't grow the delta back toward the full suite.

**Acceptance Criteria:**

**Given** a per-project snapshot from the previous run
**When** an incremental run uses the "last-run" baseline
**Then** the changed-set is files whose content differs from the snapshot (hash-based), and only their affected tests run.

**Given** a run completes
**When** it finishes
**Then** the daemon persists an updated content-hash snapshot under `.test-mcp/` (git-ignored, schema-versioned) for the next run's delta.

**Given** no valid snapshot yet
**When** a "last-run" run is requested
**Then** it falls back safely (full or git-HEAD delta) to establish the baseline — never under-selects.

**Given** the caller wants a different baseline
**When** invoking `run_tests`
**Then** the baseline is selectable (e.g. `since: "last-run" | "head"`) with a documented default; git-HEAD remains available for CI.

> Changes documented selection behaviour and the default baseline — reconcile with the architecture spine before implementing (see the story's escalation triggers, incl. the partial-run snapshot-advance safety rule).

### Story 6.9: Optional CRG-Backed Impact Analysis (backlog / spike)

As a developer on a project that already runs code-review-graph (CRG),
I want test-mcp to use CRG's blast-radius for impact analysis when it's available,
So that selection is richer where the graph exists — without ever depending on it.

**Acceptance Criteria:**

**Given** CRG is present and current in a project
**When** an incremental selection is computed
**Then** its blast-radius for the changed files is unioned into the affected-test set (augmenting, not replacing, the runtime coverage map).

**Given** CRG is absent or its graph is stale/unreadable
**When** selection runs
**Then** test-mcp falls back to the Vitest `--changed` static graph with no error and no hard dependency.

**Given** CRG informed a selection
**When** the result is reported
**Then** the reason (6.4) notes CRG's contribution and it feeds the confidence signal (6.8).

> Spike-first; introduces an optional external-tool dependency (daemon possibly acting as an MCP client) — confirm the seam with the architecture spine. Backlog: sequence after the core refinements + 6.8.

### Story 6.8: Selection Confidence Signal

As an AI developer relying on incremental runs,
I want each run to tell me how confident it is that the selected tests fully cover my changes,
So that I know when to run a full pass before calling a feature done (instead of the tool always running full).

**Acceptance Criteria:**

**Given** a bounded, provably-complete incremental selection
**When** the result is returned
**Then** it carries `confidence: { level: "high", reasons: [] }`.

**Given** selection is bounded but not provably complete (modified source unknown to the map, an unmeasurable test implicated, a deleted file's impact can't be bounded, or no snapshot/base)
**When** the result is returned
**Then** it carries `confidence: { level: "degraded", reasons: [...] }` explaining why, so the caller can run a full pass — never a silent skip.

**Given** the monitoring UI run-detail
**When** a degraded run is viewed
**Then** the confidence level and reasons are shown.

### Story 6.10: Combined Incremental Coverage

As a developer enforcing coverage (e.g. 100%) on incremental runs,
I want coverage merged across runs into a full-project picture,
So that an incremental run can report/enforce whole-project coverage without re-running everything — honestly.

**Acceptance Criteria:**

**Given** a full coverage run has established a baseline
**When** an incremental coverage run executes
**Then** the coverage map's per-test-file coverage data is refreshed for the test files that ran, and combined project coverage = union of every test file's latest measurement.

**Given** a source file changed
**When** coverage is combined
**Then** its stale coverage entry is invalidated (line shifts) until re-measured; a changed-but-unmeasured file marks the combined report degraded confidence (6.8).

**Given** a coverage threshold (e.g. 100%) is enforced
**When** the combined report is produced from an incremental run
**Then** the threshold verdict is reported together with confidence, so "100% met" is only asserted at high confidence.

> Depends on 6.3 (coverage report), 6.7 (snapshot/change model), 6.8 (confidence). Extends the coverage map to store coverage *data*, not just the reverse mapping.

## Epic 7: Runner Plugin API (Phase 2, continued)

### Story 7.1: RunnerPlugin Interface & Vitest Extraction (Zero Behavior Change)

As a maintainer extending test-mcp to new runners,
I want the current Vitest-specific worker logic extracted behind a `RunnerPlugin` interface,
So that Vitest becomes the first of several possible runners instead of a hardcoded assumption.

**Acceptance Criteria:**

**Given** the current `worker/index.ts` (`runVitest`, `measureCoverage`, `discoverTestFiles`, `readCoverageThresholds`, both `projectRequire("vitest/node")` sites)
**When** the extraction is complete
**Then** all of it moves into `src/runners/vitest/` behind the `RunnerPlugin` interface (AD-12), and `worker/index.ts` no longer calls `projectRequire("vitest/node")` itself — it dispatches through the plugin.

**Given** the existing test suite (all `test/*.test.ts` files covering worker/coverage/selection behavior)
**When** it runs against the extracted code
**Then** it passes unmodified — same options, same reporter callbacks, same `coverage-final.json` handling, no behavior or output change (AD-13's acceptance bar).

**Given** a plugin call (`run`/`listTestFiles`/`affectedTests`/`readCoverageThresholds`)
**When** it is invoked
**Then** it receives the suite's `configPath` explicitly (not cwd-based auto-discovery) — even though only one suite/config exists until Story 7.2 lands.

> Architecture: AD-12, AD-13 (`architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md`). Ships before multi-suite registration (7.2) — a single implicit suite is threaded through in the interim.

### Story 7.2: Multi-Suite Registry Model

As a developer whose project runs more than one kind of test (e.g. Vitest unit + Playwright/Jest e2e),
I want to register each as its own named suite bound to its own plugin,
So that test-mcp can select, run, and report on each independently instead of assuming one runner per project.

**Acceptance Criteria:**

**Given** a project with one or more plugin config markers present
**When** `test-mcp register` runs
**Then** it auto-detects suites via each installed plugin's `detect()` (fixed precedence order, first match wins) and populates `RegisteredProject.suites: Record<suiteName, {configPath, plugin}>`.

**Given** auto-detect can't resolve a suite (ambiguous or no match)
**When** the developer supplies an explicit `--suite name:plugin:configPath`
**Then** it upserts exactly that named suite without clearing or replacing any other registered suite.

**Given** two auto-detected suites would produce the same name
**When** registration runs
**Then** the collision is resolved by suffixing the plugin name (e.g. `unit-vitest`, `unit-jest`) rather than silently overwriting one.

**Given** an already-registered single-suite project (pre-Epic-7)
**When** it is next registered or the daemon starts
**Then** its existing `configPath` is auto-migrated into one suite entry (named from the detected plugin) with `projectId` unchanged — no re-registration required, no data loss.

> Architecture: AD-14. Depends on Story 7.1 (needs `RunnerPlugin.detect()`/`name` to exist).

### Story 7.3: Per-Suite Selection & Coverage Scoping

As an agent running tests against a multi-suite project,
I want test selection, the coverage map, and confidence to be scoped per suite,
So that one suite's changed-file or coverage data is never attributed to a different suite's tests.

**Acceptance Criteria:**

**Given** a project with more than one registered suite
**When** a run is planned or coverage is measured for one suite
**Then** `SelectionEngine.plan`, `CoverageMapFile`, `CoverageDataFile`, and `CombinedCoverage` are all keyed by `(projectId, suiteName)` and never merged across suites.

**Given** a suite whose bound plugin declares `capabilities.coverage === "none"`
**When** its combined coverage report is produced
**Then** `Confidence` reports the new `"unavailable"` level (extending the existing `high`/`degraded` union) and `thresholdsMet` stays `undefined` — never a false threshold verdict, using the same gating pattern already proven for the `degraded` case.

**Given** a suite whose plugin reports `"summary"` or `"line-hit"` coverage
**When** it is measured
**Then** existing high/degraded confidence behavior (Story 6.8/6.10) is unchanged for that suite.

> Architecture: AD-15 (selection/coverage/confidence portion). Depends on Story 7.2 (suites must exist to scope by).

### Story 7.4: Per-Suite Orchestrator & MCP Surface Scoping

As an agent calling `run_tests`/`get_test_status`/`get_failure_details` on a multi-suite project,
I want to address a specific suite and get back only that suite's state,
So that two suites of one project never clobber each other's run status, history, or failure detail.

**Acceptance Criteria:**

**Given** `run_tests`'s existing (currently unwired) `suite` parameter
**When** it is supplied
**Then** the orchestrator resolves and runs against that named suite specifically; omitting it falls back to a single default suite (or errors clearly if more than one suite exists and none is specified).

**Given** the orchestrator's `runState`/`lastFailures`/history bookkeeping (today keyed by bare `projectId`)
**When** a run completes for a given suite
**Then** that bookkeeping is keyed by `(projectId, suiteName)`, so `get_test_status` and `get_failure_details` return the correct suite's state, not whichever suite ran most recently.

**Given** the dry-run plan cache (`TestPlan`/`ProjectRef`)
**When** a plan is created and later committed
**Then** the plan is suite-scoped too — committing a `planId` against the wrong suite is rejected, not silently run.

> Architecture: AD-15 (orchestrator/MCP portion). Depends on Story 7.2 and pairs with Story 7.3.

### Story 7.5: Spike — Jest Embeddable Run API

As the developer building the Jest plugin,
I want to confirm which Jest API can run tests programmatically without exiting the worker process,
So that Story 7.6 is built on a confirmed mechanism instead of an assumption.

**Acceptance Criteria:**

**Given** the plain `jest` package's `run()` calls `process.exit()` on completion
**When** the spike investigates
**Then** it confirms whether `runCLI` from `@jest/core` is reliably resolvable via `projectRequire` from a project that declares only `jest` (not `@jest/core` directly), including under pnpm's strict resolution.

**Given** the spike's finding
**When** it completes
**Then** it reports either a confirmed embedding approach (unblocking Story 7.6) or an escalation (per this repo's dependency-authorization rule) if `@jest/core` isn't reliably resolvable — no product code is written speculatively ahead of this answer.

> Architecture: AD-16's open question. Blocks Story 7.6; can run any time (no dependency on 7.1–7.4).

### Story 7.6: Jest Plugin (Seam Validation)

As a maintainer validating the `RunnerPlugin` interface holds for a second real runner,
I want a Jest plugin implementing the interface at seam-validation scope,
So that the abstraction — not just Vitest's occupancy of it — is proven sound.

**Acceptance Criteria:**

**Given** Story 7.5's confirmed embedding approach
**When** the Jest plugin's `run()` executes
**Then** it runs the requested test files and maps results into the same `TestResult` shape the Vitest plugin produces, without exiting the worker process.

**Given** a changed-file set
**When** `affectedTests`/`changedFileDetection` is exercised
**Then** it uses Jest's real `--onlyChanged`/`-o` or `--changedSince <ref>` flags — not a fabricated flag.

**Given** Jest's `coverageReporters` output (`coverage-final.json`)
**When** coverage is requested and can be parsed with the already-pinned `istanbul-lib-coverage`
**Then** `capabilities.coverage` reports `"summary"`; otherwise it honestly reports `"none"` — no new runtime dependency either way.

**Given** a hermetic fixture Jest project (mirroring the Vitest plugin's own test pattern)
**When** the Jest plugin's test suite runs
**Then** it passes to the same rigor as the Vitest plugin's tests — proving the interface, not matching Vitest's feature surface (no per-test-file coverage map, no static-graph `affectedTests` parity required).

> Architecture: AD-16. Depends on Story 7.1 (interface), Story 7.2 (registry model), Story 7.5 (spike answer).

## Epic 8: Async Execution & Observability (Phase 2, continued)

> ⚠️ **Do not begin implementation of any Epic 8 story.** The user has asked to review the full epic/story breakdown first and give explicit go-ahead before any code is written. This applies to every story below.

### Story 8.1: IPC Protocol — New FromWorker Message Types

As a maintainer adding worker→daemon observability signals,
I want four new `FromWorker` message types defined and Zod-validated,
So that the worker and orchestrator changes in later stories have a shared, type-safe contract to build against.

**Acceptance Criteria:**

**Given** `src/types/ipc.ts`'s existing `FromWorker` discriminated union (`ready`/`progress`/`result`/`error`) and its Zod `FromWorkerSchema`
**When** this story is complete
**Then** it gains four additive variants, each carrying `runId: string` (matching the existing `progress`/`result`/`error` convention):
- `{ type: "config"; runId: string; testTimeoutMs: number }`
- `{ type: "case-start"; runId: string; file: string; name: string }`
- `{ type: "case-result"; runId: string; file: string; name: string; status: "passed" | "failed" | "skipped" }` (reuses the exact same three-literal status enum already used by `TestResult.tests[].status` — no `"pending"` literal; Vitest's `pending` state is never forwarded, matching how `mapModulesToResult` already folds it into `"failed"`)
- `{ type: "phase-progress"; runId: string; phase: "coverage"; completed: number; total: number }`

**Given** each new variant
**When** a corresponding Zod schema object is added to the existing `z.discriminatedUnion("type", [...])` in `FromWorkerSchema`
**Then** `parseFromWorker` accepts a well-formed message of each new type and returns the correctly-typed object, and rejects (throws) a malformed one (missing field, wrong type) exactly like the existing variants do.

**Given** the existing `ToWorker` union
**When** this story is complete
**Then** it is unchanged — this story only adds to `FromWorker`.

> Architecture: AD-18, AD-19, AD-20 (message shapes). No dependencies — this is the foundational story every other Epic 8 story builds on. Do NOT touch `src/orchestrator/index.ts` or `src/worker/index.ts` in this story — only `src/types/ipc.ts` and its test file.
>
> Testing: extend `test/ipc-validation.test.ts` with round-trip (valid → parses to the exact shape) and rejection (malformed variant throws) cases for all four new message types.

### Story 8.2: Worker — Resolved-Config Discovery & Per-Test Reporter Hooks

As the worker executing a project's tests,
I want to report the project's resolved `testTimeout` before the real run starts, and forward per-test start/result events when Vitest supports them,
So that the orchestrator (later stories) can arm an accurate stall watchdog and build a live per-test view.

**Acceptance Criteria:**

**Given** the existing `readCoverageThresholds()` in `src/worker/index.ts` (a `createVitest("test", {watch:false})` discovery instance, not `startVitest`, reading `vitest.config?.coverage?.thresholds` then closing it, never running tests)
**When** this story generalizes it into a `readResolvedRunConfig()` function returning `{ testTimeoutMs?: number; coverageThresholds?: unknown }` from the **same single** discovery instance
**Then** `readCoverageThresholds` is deleted, and `buildAndPersistCoverageMap`'s one call site takes `thresholds` as a new parameter instead of calling `readCoverageThresholds` internally.

**Given** `handleRun()` (`src/worker/index.ts`)
**When** it begins handling a `run` message
**Then** it calls `readResolvedRunConfig()` **first**, and if `testTimeoutMs` came back as a number, sends `{type:"config", runId: msg.runId, testTimeoutMs}` before proceeding to `runVitest(...)` as today. If `testTimeoutMs` is `undefined` (discovery failed or the field was unreadable), no `config` message is sent at all — the orchestrator's fallback default applies (Story 8.5).

**Given** `runVitest()`/`runOnce()`'s current signatures (`cwd, opts, onProgress`)
**When** this story threads `runId` down into both
**Then** the reporter object built inside `runOnce()` can stamp `runId` on every message it sends, and no other behavior of `runVitest`/`runOnce` changes.

**Given** the reporter object in `runOnce()` (currently wiring `onTestRunStart`/`onTestModuleEnd`/`onTestRunEnd`)
**When** this story adds two more properties, `onTestCaseReady(testCase)` and `onTestCaseResult(testCase)`
**Then** each is wrapped in its own `try {} catch {}` (a malformed/unexpected `TestCase` shape from Vitest must never crash the worker or abort the run) and sends, respectively, `{type:"case-start", runId, file: testCase.module.moduleId, name: testCase.fullName}` and `{type:"case-result", runId, file: testCase.module.moduleId, name: testCase.fullName, status: testCase.result().state}`.

**Given** a project whose installed Vitest predates `onTestCaseReady`/`onTestCaseResult` (Vitest 3+ only)
**When** a run executes against it
**Then** Vitest itself simply never calls those two reporter properties — no explicit feature-detection is written in this codebase, and the run proceeds exactly as it does today (module-level `progress` only).

**Given** `buildAndPersistCoverageMap`'s `measure` closure (the per-file coverage measurement callback, currently silent — sends nothing)
**When** this story adds one `send()` call after each file's coverage is measured
**Then** it sends `{type:"phase-progress", runId, phase:"coverage", completed: <files measured so far>, total: <target file count>}` — this is **required** for this story to be considered done, not an optional enhancement (Story 8.4's stall watchdog depends on it to avoid false-positive kills during coverage measurement).

> Architecture: AD-18 (reporter hooks), AD-20 (config discovery, coverage-phase heartbeat). Depends on Story 8.1 (the message types must exist first). Only touch `src/worker/index.ts` and its test file(s) in this story — do not touch `src/orchestrator/index.ts`.
>
> Testing: extend/add a worker-level test using the real Vitest 4.1.9 + `test-fixtures/sample-project` (per `test/mcp-run-tests.test.ts` conventions) that forks the real `dist/worker/index.js`, collects IPC messages, and asserts: (a) a `config` message with the fixture's resolved `testTimeout` arrives before the first `progress`/`result`; (b) at least one `case-start`/`case-result` pair per test name in the fixture's `pass.test.ts`/`fail.test.ts`, with `status` matching the known outcome; (c) running with `coverage: true` against a fixture with ≥2 test files produces at least one `phase-progress` message before the final `result`.

### Story 8.3: Daemon & CLI — Grace-Period and Stall-Grace Configuration

As an operator running the daemon,
I want the async grace period and stall-watchdog grace both configurable at the daemon and per-project level,
So that a project with unusually long individual tests (or an operator who wants full synchronous behavior) isn't fighting a one-size-fits-all default.

**Acceptance Criteria:**

**Given** `DaemonConfigSchema` in `src/daemon/index.ts` (currently `schemaVersion`, `port`, `maxConcurrentWorkers`, `workerIdleTtlMs`, `token?`, `runTimeoutMs?`)
**When** this story adds two fields
**Then** it gains `defaultRunWaitMs: z.number().int().nonnegative().nullable().optional().default(10_000)` and `staleTestGraceMs: z.number().int().positive().default(5000)`.

**Given** `loadOrCreateConfig()`'s fresh-config literal (the object written when no `config.json` exists yet)
**When** this story is complete
**Then** that literal explicitly includes `defaultRunWaitMs: 10_000` and `staleTestGraceMs: 5000` (Zod's `.default()` only applies during `safeParse` of an existing file, not to a hand-constructed literal — both must be set explicitly here or a fresh install would have `undefined` instead of the intended default).

**Given** an existing `config.json` written before these two fields existed
**When** `loadOrCreateConfig()` parses it
**Then** it parses successfully (both fields are `.optional()` with Zod defaults) and the resolved config has `defaultRunWaitMs: 10_000`/`staleTestGraceMs: 5000` filled in — no migration needed, no error.

**Given** `startDaemon()`'s `new Orchestrator({...})` call
**When** this story is complete
**Then** it passes `staleTestGraceMs: cfg.staleTestGraceMs` through (the `defaultRunWaitMs` value is consumed later, in Story 8.6, by the MCP layer directly from `DaemonConfig` — it does not need to reach the `Orchestrator` constructor).

**Given** `ensureProjectConfig()` in `src/cli/main.ts` (writes `<gitRoot>/.test-mcp/config.json` as `{schemaVersion, projectId, stateDir}`)
**When** this story is complete
**Then** the written/read shape additionally supports an optional `defaultRunWaitMs?: number | null` field — `ensureProjectConfig` itself does not need to prompt for or set a value (it stays absent unless a user hand-edits the file or a future story adds a CLI flag), it only needs to not strip/reject the field if present, and the type this function returns/reads reflects the new optional field.

> Architecture: AD-17 (config layering), AD-20 (`staleTestGraceMs`). No dependency on Story 8.1/8.2 — this is pure config-schema plumbing and can be built in parallel with them. Only touch `src/daemon/index.ts` and `src/cli/main.ts` (plus their existing test files) in this story.
>
> Testing: extend `test/daemon.test.ts` (or add a focused test) asserting: a fresh `config.json` includes both new fields with their documented defaults; an old-shape `config.json` (missing both fields) still parses via `safeParse` with the defaults filled in; `startDaemon()` threads `staleTestGraceMs` into the constructed `Orchestrator`.

### Story 8.4: Orchestrator — Async `run_tests` Core (`startRun` and `runId` Threading)

As the orchestrator executing a test run,
I want to hand back a `runId` the instant a run is accepted, independent of when the run actually finishes,
So that a caller can be given a job handle before the run completes.

**Acceptance Criteria:**

**Given** `executeWorker()` in `src/orchestrator/index.ts` (currently generates `runId = randomUUID()` internally, inside the function, and never exposes it until the returned promise settles)
**When** this story adds a new public method `startRun(project, opts): { runId: string; result: Promise<TestResult> }`
**Then** `runId` is generated synchronously at the top of `startRun`, before any async work begins, and returned immediately alongside the (not-yet-settled) `result` promise; `executeWorker` receives `runId` as a parameter instead of generating its own.

**Given** the existing `runTests()`/`runPlan()` public methods (today: `async runTests(...) { ...; return this.enqueue(...); }`)
**When** this story refactors them
**Then** each becomes a thin wrapper — `async runTests(...) { const { result } = this.startRun(...); return result; }` (same for `runPlan`) — so every existing direct caller (including all current tests that `await orchestrator.runTests(...)`) observes byte-for-byte identical behavior: same resolved `TestResult`, same rejection type/message on failure.

**Given** `enqueue()`'s existing empty-selection short-circuit (the branch that returns a trivial success `TestResult` for a no-op run via its own separate `randomUUID()` call, today entirely disconnected from `executeWorker`'s `runId`)
**When** this story is complete
**Then** that branch takes its `runId` from the same `startRun` call (no second, independent `randomUUID()`), and its `setRunState(...)` call includes that same `runId` — so `RunStatus.runId` and the persisted `RunRecord.runId` agree for a no-op run exactly as they do for a real one.

**Given** `RunStatus` (currently `{state, progress?, lastResult?, lastError?, updatedAt?}`)
**When** this story adds `runId?: string`
**Then** every `setRunState(...)` call that transitions a project to `state: "running"` also sets `runId` to the run's id, and it is cleared (or left stale-but-harmless — decide and state which in the story's Dev Agent Record) once the run settles, matching how the rest of `RunStatus` already behaves around a settled run.

**Given** any of the four new IPC message types from Story 8.1 arriving via `child.on("message", ...)`
**When** its `runId` does not match the `runId` this `executeWorker` call was started with
**Then** it is discarded (no state mutation, no crash) — the exact same discipline already applied to `progress`/`result`/`error` today (`msg.runId === runId` guards, and the existing `unexpected IPC ${msg.type} for run ${runId}` failure path for a mismatched `result`/`error`).

> Architecture: AD-17 (core mechanism, `runId` exposure). Depends on Story 8.1 (message types must exist for the `runId`-matching guard, even though this story's own new messages aren't handled yet — that's Story 8.5). Independent of Story 8.2/8.3. Only touch `src/orchestrator/index.ts` and its existing test files in this story — do not add live-state/watchdog logic yet (Story 8.5) and do not touch `src/mcp/server.ts` yet (Story 8.6).
>
> Testing: extend `test/orchestrator-*.test.ts` (or add a new focused file) asserting: `startRun` returns a `runId` synchronously before `result` settles; `runTests`/`runPlan` still resolve/reject exactly as before (existing tests for these must keep passing unmodified — this is the acceptance bar, mirroring AD-13's "zero behavior change" precedent from Epic 7); the empty-selection short-circuit's `RunStatus.runId` matches its persisted `RunRecord.runId`.

### Story 8.5: Orchestrator — Live State, Bounded Log Capture & Stall Watchdog

As an operator or agent with a run in flight,
I want a live, bounded view of which tests are running/done and the worker's console output, and I want a genuinely wedged worker killed automatically,
So that a long run is observable instead of opaque, and a hang is caught instead of waited out forever.

**Acceptance Criteria:**

**Given** `executeWorker()`'s `fork()` call (currently `stdio: ["ignore","ignore","inherit","ipc"]`)
**When** this story changes it to `stdio: ["ignore","pipe","pipe","ipc"]`
**Then** `child.stdout`/`child.stderr` are readable streams; a `data` handler on `child.stderr` both writes the chunk through to `process.stderr` unchanged (preserving today's passthrough exactly) AND appends it to a new per-project log ring; a `data` handler on `child.stdout` appends to the same ring but is **not** forwarded anywhere else.

**Given** a new per-project `LiveRunState` (`runId`, `testTimeoutMs?`, `lastProgressAt`, a `tests: Map` keyed `(file, name)`, `testOrder: string[]`, `testsTruncated: boolean`, `log: LiveLogLine[]`, `stdoutResidual`/`stderrResidual` strings), stored in a new `private readonly liveRuns = new Map<string, LiveRunState>()` keyed by `projectId`
**When** a run starts
**Then** an entry is created immediately (before the worker even reaches "ready"), and constants `MAX_LIVE_TEST_ENTRIES = 2000`, `MAX_LOG_LINES = 1000`, `MAX_LOG_LINE_CHARS = 4000`, `MAX_RESIDUAL_CHARS = 8000` bound its growth: the test list is a **ring** (oldest evicted past 2000, `testsTruncated` set true once eviction starts, never frozen on the first 2000), the log is a ring capped at 1000 lines (each capped at 4000 chars), and a partial (no-newline) chunk is held as residual and force-flushed as a truncated line if it exceeds 8000 chars before a newline arrives.

**Given** the log-appending logic
**When** it splits an incoming chunk on `\n`
**Then** the trailing (possibly partial) segment is kept as residual for the next chunk, complete lines are pushed into the ring, and any non-empty residual is flushed as a final line when the run settles (success, error, or watchdog kill) — no trailing partial line is silently dropped.

**Given** `child.on("message", ...)` in `executeWorker`
**When** a `config`/`case-start`/`case-result`/`phase-progress` message arrives (all four filtered by `runId` per Story 8.4's rule)
**Then**: `config` records `testTimeoutMs` on the `LiveRunState` and (re)arms the watchdog (see below); `case-start` upserts a `pending`→`running` entry (or a fresh `running` entry if `case-start` for that key was never seen); `case-result` upserts the entry to its terminal status (`passed`/`failed`/`skipped`) even if it's past the `MAX_LIVE_TEST_ENTRIES` cap for an already-tracked key; `phase-progress` does not touch the test list but does count as a progress signal (see watchdog below) and is itself recorded on `LiveRunState` (e.g. a `phase` field) so it can be surfaced identically to test-level progress later (Story 8.6/8.7 read it — this story only needs to store it, not display it).

**Given** the existing `runTimeoutMs` opt-in timer and its `finish()` helper (clears timers, removes child listeners, kills the child exactly once)
**When** this story adds the stall watchdog
**Then** a **provisional** watchdog arms the instant the worker is forked, using `staleTestGraceMs` alone as its threshold (catching a hang in the worker's own `config`-discovery step, before any `config` message could arrive); once a `config` message lands, the orchestrator replaces it with the real watchdog armed at `testTimeout + staleTestGraceMs`. Either watchdog is reset (not just re-checked — a full `setTimeout` reschedule) on every `case-start`/`case-result`/module-level `progress`/`phase-progress` signal. On fire, it calls the **same** `finish()` helper the `runTimeoutMs` cap already uses (no second kill path), producing `new WorkerError(\`worker stalled: no test progress for ${elapsed}ms (threshold ${threshold}ms = testTimeout ${effectiveTestTimeoutMs}ms + grace ${this.staleTestGraceMs}ms)\`)` — a message distinguishable by substring from both `worker timed out after {N}ms` and `worker exited (code {c}, signal {s})...`.

**Given** log-line arrival (stdout or stderr data)
**When** the watchdog logic runs
**Then** log-line arrival is explicitly **never** treated as a progress signal — only the four signal types named above reset the watchdog, so a worker that merely keeps writing to stderr while otherwise wedged is still correctly detected as stalled.

**Given** `finish()` (extended by this story)
**When** a run settles for any reason
**Then** it also clears whichever watchdog timer (provisional or real) is currently active, and flushes any non-empty log residual — but it does **not** delete the `liveRuns` entry for that project; the entry (test list + log ring) is retained until the **next** run for that project starts (so `GET .../log` or a `get_test_status` poll immediately after a stall-kill or error still shows the state that led to it), at which point it is replaced by a fresh entry for the new run.

**Given** a new read accessor `getLiveRun(projectId): { runId, testTimeoutMs?, tests: LiveTestEntry[], testsTruncated, logTail: LiveLogLine[] } | undefined`
**When** called
**Then** it returns `undefined` only if no run has ever started for that project (never mid-settle-cleanup, per the retention rule above), otherwise the current `LiveRunState` in `testOrder` order.

**Given** the existing fan-out loop inside `setRunState` (iterates `statusListeners`, try/catch per listener)
**When** this story factors it into a shared private `notifyStatusChange()` helper
**Then** both `setRunState` and every live-state mutation above call it, so the UI's existing SSE push (`onStatusChange`) fires on live-state changes too, not just coarse `RunStatus` transitions.

> Architecture: AD-18 (live test list), AD-19 (log capture), AD-20 (watchdog). Depends on Story 8.1 (message types), Story 8.2 (worker must actually send them), Story 8.3 (`staleTestGraceMs` config must exist), Story 8.4 (`runId`-filtering discipline this story's message handling relies on). Only touch `src/orchestrator/index.ts` and its test files — do not touch `src/mcp/server.ts` or `src/ui/index.ts` yet.
>
> Testing: extend `test-fixtures/blocking-worker/worker.mjs` with sentinel-file triggers to send `config`/`case-start`/`case-result`/`phase-progress` on demand (mirroring its existing `started`/`release`/`crash` convention) so tests never wait out a real `testTimeout`. New `test/orchestrator-stall-watchdog.test.ts`: fires on true stall within a small configured threshold; does not fire while progress signals keep arriving (proves the timer resets, not a fixed deadline); falls back to the lenient provisional default when `config` is never sent; message substring distinguishable from `runTimeoutMs`'s; log output alone (no progress signal) does not prevent a stall-kill. New `test/orchestrator-live-run.test.ts`: live test list populates and rings correctly at the 2000 cap; log ring bounds at 1000 lines; two concurrent different-project runs don't cross-contaminate each other's buffers; live state is retained (not `undefined`) immediately after a run errors or is stall-killed, and is replaced (not merged) once the next run for that project starts; stdout is captured while stderr is captured AND still passed through to the daemon's own `process.stderr` unchanged (regression guard).

### Story 8.6: MCP Surface — Async `run_tests` Handler & `get_test_status` Live Payload

As an MCP client calling `run_tests`,
I want a fast run to return its result as it always has, and a slow run to return a job handle I can poll instead of my connection timing out,
So that I never lose the outcome of a test run just because it took longer than my own client's patience.

**Acceptance Criteria:**

**Given** `run_tests`'s tool input schema (`src/mcp/server.ts`)
**When** this story adds an optional argument
**Then** it gains `waitMs: z.number().nullable().optional()` — `null` must validate and reach the handler distinctly from an omitted argument (not stripped or coerced).

**Given** the handler's effective-`waitMs` resolution
**When** it runs
**Then** it resolves in this order: the `waitMs` argument if provided (including explicit `null`) → the project's `.test-mcp/config.json` `defaultRunWaitMs` if set (including explicit `null`) → the daemon's `DaemonConfig.defaultRunWaitMs` → `10_000` if nothing above is set. `null` at whichever layer wins means "wait forever."

**Given** a resolved `waitMs` of `null`
**When** `run_tests` (non-dry-run) executes
**Then** it calls `orchestrator.startRun(...)`, immediately `await`s `result` directly (no race, no timer), and returns the full `TestResult` — byte-for-byte today's existing synchronous behavior.

**Given** a resolved `waitMs` that is a number
**When** `run_tests` executes
**Then** it calls `startRun(...)`, attaches a `.catch(() => {})` to `result` so it can never become an unhandled rejection once detached, and races `result` against a `waitMs` timer: **on an exact tie, the result wins** — never returning a job-handle for a run whose result was already available. If `result` wins, return the full `TestResult` (unchanged from today). If the timer wins, return `{runId, projectId, state:"running", message: "still running after " + waitMs + "ms; poll get_test_status with this projectId"}` — the run keeps executing in the background regardless.

**Given** `run_tests`'s tool description (currently: `"Run tests for a registered project"`)
**When** this story updates it
**Then** it documents the new contract explicitly, mirroring `start_watch`'s existing "poll get_test_status" phrasing — e.g. stating that a run exceeding the grace period returns a job handle to poll instead of the result.

**Given** `get_test_status`'s handler (currently returns `{...orchestrator.getRunStatus(projectId), watch: watchManager?.status(projectId)}`)
**When** this story is complete
**Then** it additionally calls `orchestrator.getLiveRun(projectId)` and, if defined, nests the result under one `live: {tests, log, phase?, lastProgressAt}` key in the response (never spread flatly, never reusing the existing `lastResult.tests` field name) — carrying the full bounded live state (no further slicing beyond the orchestrator's own `MAX_LIVE_TEST_ENTRIES`/`MAX_LOG_LINES` caps), since a poll is a deliberate single-project request, not a broadcast.

> Architecture: AD-17 (async handler), AD-21 (MCP payload parity). Depends on Story 8.3 (config fields), Story 8.4 (`startRun`), Story 8.5 (`getLiveRun`). Only touch `src/mcp/server.ts` and its test files — do not touch `src/ui/index.ts` yet (Story 8.7).
>
> Testing: new `test/mcp-run-tests-async.test.ts` using the blocking-worker fixture (controlled timing, no real waits): a run finishing inside `waitMs` returns the full `TestResult` unchanged; a run still going after `waitMs` returns `{runId, projectId, state:"running"}` and keeps executing afterward, verified by a subsequent `get_test_status` poll observing progress and eventually reaching `state:"complete"` with the matching `runId`; `waitMs: null` waits forever exactly like today; the four-layer resolution order (call → project → daemon → 10s default) is exercised at each layer independently. Extend `test/mcp-server.test.ts`: `get_test_status`'s payload includes `runId` and (while a run is live) a `live` key with the expected shape; `run_tests`'s tool description text mentions polling (a cheap regression guard against silently reverting the contract).

### Story 8.7: UI — Live Test List & Log Tail with Follow

As a human watching the monitoring UI during a long-running test suite,
I want to see which tests are currently running/passed/failed and follow the worker's console output live,
So that I can tell what's actually happening instead of staring at an unchanging "running" badge — including confirming whether a suite has genuinely finished its tests but the process hasn't exited.

**Acceptance Criteria:**

**Given** `uiSnapshot()` in `src/ui/index.ts` (currently builds `{serverTime, projects: ProjectView[]}` with no per-test/log data)
**When** a project's `run.state === "running"`
**Then** its `ProjectView` gains a `live` field sourced from `orchestrator.getLiveRun(projectId)`: `tests` sliced to the most-recently-touched `MAX_SNAPSHOT_TESTS = 200` entries, `log` sliced to `.slice(-20)`, plus `testsTruncated`/`testsShown` so the UI can render "showing 200 of 1400." A project not in `"running"` state has no `live` field at all.

**Given** `handleUiRequest()`'s existing route-dispatch convention (`/ui/api/projects/:projectId/runs[/:runId]`)
**When** this story adds two new routes
**Then** `GET /ui/api/projects/:projectId/log` returns `{projectId, runId, log}` — the **full** current ring (up to 1000 lines, no further slicing) as a one-shot JSON fetch — and `GET /ui/api/projects/:projectId/log/events` opens an SSE stream that pushes only the log lines newer than the connection's own last-sent index (tracked in a closure per connection, not resent from scratch on every tick), plus the same 15-second `: keep-alive` comment pattern already used by `/ui/events`. Both are GET-only, read-only, loopback + Host/Origin gated exactly like every existing `/ui*` route — no new mutation surface, no bearer-token requirement (matching the existing `/ui*` convention).

**Given** `renderProject()` in the inline `UI_HTML` template
**When** the project's `p.live` field is present
**Then** it renders a live test list grouped by file (reusing the existing `relPath()` helper), one row per test with a status-colored badge — extend the existing `.ok`/`.fail`/`.skip` CSS classes with a new `.run` color for `"running"` status, following the exact `<ul class="tests">` markup pattern already used in `renderRun()` for a completed run's test list.

**Given** the same running-project view
**When** this story adds a log panel
**Then** it is a collapsible `<details>` block (matching the existing pattern already used for `tests`/`selection` sections) with a "follow" checkbox; entering the view does a one-shot `GET .../log` to seed the panel, then opens `new EventSource(".../log/events")` and appends each pushed delta into a `<pre>`, auto-scrolling to bottom only while "follow" is checked. Navigating away from that project's view (via the existing hash-router's `render()` dispatch) closes the `EventSource` — no leaked open SSE connections when browsing between projects.

> Architecture: AD-21 (UI-side of MCP/UI parity). Depends on Story 8.4/8.5 (`getLiveRun` must exist). No dependency on Story 8.6 (the UI reads the orchestrator directly, not through the MCP tool layer). Only touch `src/ui/index.ts` and its test files in this story.
>
> Testing: extend `test/ui.test.ts`: the snapshot's `live` field is present (with the documented 200/20 slicing) while a project is running and absent once it completes; the new `GET .../log` route returns the full (not sliced) ring; the new `GET .../log/events` SSE route's second push (after more log lines are appended by a running fixture) contains only the new lines, not a full resend; both new routes 404 cleanly for an unknown `projectId`, matching the existing `/runs` 404 behavior.
