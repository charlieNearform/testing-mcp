# Product Requirements Document

## Overview

Build an MCP (Model Context Protocol) server that provides intelligent test orchestration capabilities for JavaScript/TypeScript projects. The primary consumer is AI agents, with a simple web UI built on top for human developers.

### Job Statement

> "When tests fail, AI agents hire this tool to [orchestrate intelligent test runs] so they can [minimize wait time while ensuring reliability]."

### User Profile

**Primary User: AI Agents**
- Need programmatic test triggering via MCP
- Require structured JSON results
- Benefit from intelligent test selection
- Need dry run mode to evaluate before committing

**Secondary User: Human Developers**
- Benefit from the simple web UI built on the MCP
- Want visual status representation
- Need manual trigger controls and history viewer

### Problem Statement

Current test running workflows have several pain points for AI agents:

1. **Exhaustive re-runs**: Every change triggers a full suite execution—even when only one file changed
2. **No intelligent caching**: Running tests after small changes re-runs the entire suite
3. **Verbose output**: Hard to quickly identify failures in large test suites
4. **No programmatic access**: LLM agents can't programmatically trigger tests or query results
5. **No dry run capability**: Can't queue tests without executing them

---

## Competitive Landscape & Positioning

As of mid-2026 this is an actively forming space — several tools already do runtime,
coverage-based test selection for agents, so **coverage-based selection is table-stakes,
not our differentiator**:

- **`testpick`** — coverage-based selection (Vitest + Jest) via single-pass, sharded V8
  precise-coverage delta attribution, with an `explain` command and a deliberate
  recall-first ("run more when unsure") bias. This is essentially the Epic 3 engine.
- **`vitest-agent`** — a Vitest plugin + reporter + CLI + MCP server + Claude Code plugin
  that persists runs to SQLite and exposes status/coverage/failure-history over MCP.
- **`vitest-affected`** — runtime reverse-dependency map (~5ms selection), explicitly
  aimed at parallel AI agents.
- **`djankies/vitest-mcp`, `@madrus/vitest-mcp-server`** — AI-optimized Vitest MCP runners.
- **Native `vitest --stale`** (proposed, vitest#9917) — mtime-based, git-free incremental
  selection built for "agentic coding systems"; if it lands it covers the simple
  single-project case.

**Our differentiator is the delivery architecture, not the selection idea:**

1. **One always-on daemon serving many projects** over Streamable HTTP — versus per-call
   stdio wrappers or per-project config plugins. The coverage map and history stay warm;
   one process coordinates runs across projects and parallel agents.
2. **Project-local execution / version isolation** — each project runs under its *own*
   installed Vitest version in an isolated worker; a monorepo or a machine with mismatched
   versions doesn't break.
3. **Transparent, repo-local state** in a git-ignored `.test-mcp/` you can read and diff —
   not a hidden database.
4. **Setup-baseline subtraction as first-class correctness** — real suites with a global
   `setupFiles` otherwise make every source look like it triggers the whole suite.

This wedge is a feature advantage, not a durable moat (a competitor could add a daemon
mode). We accept that and compete on execution: ship the daemon + isolation layer, and
keep the recall-first fallback loud and default.

**Decision (2026-07-10) — coverage engine sourcing:** `testpick` is MIT-licensed but is a
CLI that *owns the test run* (it shards files and spawns the runner) with no importable
API — wrapping it would mean shelling out to another CLI and nesting two orchestrators,
the exact pattern this project replaces, on top of a v0.1 single-author dependency. So we
**port/vendor its MIT V8 snapshot-diff attribution algorithm into our own worker** rather
than either wrapping the CLI or reinventing the algorithm from scratch. We keep our
daemon/worker/state architecture and add setup-baseline subtraction ourselves, and we
retain testpick's MIT copyright and license notice for the vendored portion. See
`_bmad-output/planning-artifacts/prfaq-test-server-mcp.md`.

## Product Structure

This product consists of two distinct layers:

### Layer 1: Core MCP Server (Primary Focus)

The MCP server is the main product: a **persistent on-system daemon** that AI agents
talk to instead of invoking `vitest` directly. It runs continuously on the developer's
machine (or CI host) and manages **multiple registered projects**.

**Interaction model:**
1. A **single** daemon runs on-system as a long-lived process (Streamable HTTP transport),
   enforced as a singleton via a lockfile + known port in the daemon's central directory.
2. From any project with a vitest/vite config, the developer/agent runs `test-mcp register`
   (a thin CLI bin). It ensures the daemon is up — **auto-booting the shared instance if it
   isn't** (skippable in CI) — then registers the project. If it can't reach or boot the
   daemon, it exits non-zero with a clear message so the agent bails and prompts the user.
3. The agent then drives all test activity through MCP tools (`run_tests`, `get_test_status`,
   `get_failure_details`, …), scoped by `projectId` — never shelling out to `vitest`.
4. The daemon runs each project's tests in a **per-project worker subprocess** with CWD =
   project root, resolving `vitest/node` from the *project's own* `node_modules` (so the
   project's Vitest version, config, and plugins are used). The daemon/CLI version is
   decoupled from any project's Vitest version.
5. Per-project intelligence (coverage map, run history) is persisted keyed by `projectId`,
   so it survives daemon restarts and accumulates across sessions (see State Model below).

**State model:**
- **Per-project state** lives in the repo at `<git-root>/.test-mcp/` (configurable), and is
  git-ignored on init — visible but not committed, deliberately not a black box. It holds
  `config.json` (`projectId`, `stateDir`), the coverage map, and run history.
- **Daemon-global state** (project registry, pid, port, lockfile) lives centrally (e.g.
  `~/.test-mcp/`), never inside a project.
- `projectId` defaults to a hash of the absolute project path and can be pinned in the
  project's `config.json`.

**Key characteristics:**
- Programmatic interface only (no direct human interaction)
- Single long-lived, multi-project daemon over Streamable HTTP; optional stdio single-project mode
- Executes tests via project-local Vitest in isolated per-project worker subprocesses
- Optimized for CI/CD and local agent workflows
- Intelligent test selection based on coverage and git deltas
- Progress notifications during runs, with pollable status (true push streaming is a Layer 2 UI concern — see Technical Feasibility)
- Reliable error reporting

**Primary consumers:** AI agents (register a project, then orchestrate runs via MCP)

**Secondary consumers:** CI/CD pipelines (use the MCP server directly)

### Layer 2: Human UI (Built on MCP)

A simple web interface built on top of the MCP server for human developers to monitor test runs.

**Key characteristics:**
- Visual status representation
- Manual trigger controls
- History viewer
- Simple failure inspection

**Target users:** Human developers who want visibility without CLI

**Relationship:** The UI is purely convenience - all functionality is available through the MCP. The UI cannot function without the MCP backend. Human developers benefit indirectly when AI agents use the system effectively.

---

## Phasing

This is the single source of truth for scope phasing. The product brief and brainstorm
intent are aligned to it.

**Phase 1 (MVP):** Epics 1–4 below.
- Persistent on-system MCP daemon (Streamable HTTP) with runtime project registration
- Per-project persisted state (coverage map + run history) keyed by project path
- Vitest integration via the programmatic API
- Structured JSON output with progressive disclosure
- Dry run mode
- Git-aware delta selection (static import graph, via Vitest `--changed`)
- Coverage-based reverse-dependency mapping for smart re-run (table-stakes for agent test
  tools in 2026 — see Competitive Landscape; our edge is the daemon/isolation delivery, not
  this alone)
- Test isolation verified via Vitest's built-in isolation

**Phase 2:** Priority scoring (git recency + failure history), test health monitoring,
and the Human Monitoring UI (Epic 5).

**Phase 3 / deferred:** Jest & pytest support, priority-based sharding, IDE
integration, trend analytics, suggested fixes, dependency-graph visualization,
fixture/setup-time cost tracking, ordering-dependency detection, and parallel
resource-contention quotas. (The last three were raised in brainstorming as
"must-haves" but are research-grade features; they are explicitly deferred until the
core selection engine is proven.)

---

## User Stories

### Epic 1: Core Infrastructure (Phase 1)

#### Story 1.1: Singleton Daemon Setup & Lifecycle
**ID:** `setup-001`

Set up the on-system daemon as a singleton with its own central config/state (HTTP port,
central state dir, lockfile) — distinct from any individual project's config. Provide a
thin CLI bin (`test-mcp`) with `start` / `stop` / `status`.

**Acceptance criteria:**
1. Given the daemon is installed
   When it starts
   Then it reads/validates its server config (port, central state dir), writes a lockfile with its pid/port, and listens

2. Given a daemon is already running
   When `test-mcp start` is invoked again
   Then it does not start a second instance; it reports the running instance (singleton enforced via lockfile)

3. Given the daemon starts
   When configuration is loaded
   Then it advertises available capabilities and rehydrates the previously persisted set of registered projects

4. Given `test-mcp status` / `stop` is invoked
   Then status reports pid/port/registered projects, and stop cleanly shuts down and removes the lockfile

#### Story 1.2: Basic MCP Server Implementation
**ID:** `setup-002`

Implement the core MCP server with standard tools over Streamable HTTP (with an optional
stdio single-project mode).

**Acceptance criteria:**
1. Given the server starts
   When a client connects (Streamable HTTP, or stdio in single-project mode)
   Then the server advertises test-running tools per MCP spec

2. Given the server receives a `run_tests` tool call
   When the call includes a valid `projectId` and parameters
   Then the server executes tests for that project and returns results

3. Given the server receives an invalid tool call (bad params or unknown `projectId`)
   When validation fails
   Then the server returns a proper error response

#### Story 1.3: Project Registration
**ID:** `setup-003`

Let an AI agent register, list, and unregister projects at runtime so one daemon can serve
many projects. Registration is driven by `test-mcp register`, which bootstraps everything
needed for a first-time project.

**Acceptance criteria:**
1. Given a project directory with no `.test-mcp/`
   When `test-mcp register` is run
   Then it creates `<git-root>/.test-mcp/config.json` (with `projectId` = hash of the absolute path, and `stateDir`), and adds `.test-mcp/` to the repo's `.gitignore` if absent

2. Given the daemon is not running
   When `test-mcp register` is run (locally, without `--no-spawn`)
   Then it auto-boots the singleton daemon, waits for readiness, then registers; if it cannot boot/reach the daemon it exits non-zero with a message instructing the user to start it

3. Given a directory containing a valid vitest/vite config
   When `register_project` is invoked (via the CLI or MCP)
   Then the server validates the config, uses the config's `projectId`, persists the registration in the central registry, and returns it

4. Given a path with no resolvable vitest/vite config
   When `register_project` is called
   Then the server returns a validation error and does not register the project

5. Given one or more registered projects
   When the agent calls `list_projects`
   Then the server returns each `projectId`, path, and last-known status

6. Given a registered project
   When the agent calls `unregister_project`
   Then the server removes it from the active registry (the project's `.test-mcp/` state is retained unless a purge flag is set)

### Epic 2: Test Runner Integration (Phase 1)

#### Story 2.1: Vitest Integration
**ID:** `vitest-001`

Integrate Vitest as the primary test runner via the `vitest/node` programmatic API
(`startVitest` / `createVitest`), not by parsing CLI output. Execution happens in a
**per-project worker subprocess** so the project's own Vitest is used.

**Acceptance criteria:**
1. Given a registered project
   When tests are run
   Then the daemon spawns a worker subprocess with CWD = project root that resolves `vitest/node` from the *project's* `node_modules` (not the daemon's) and executes via the API (not CLI)

2. Given two projects on different Vitest versions
   When both run
   Then each uses its own installed Vitest version without cross-contaminating the daemon process

3. Given tests are running
   When the process completes
   Then results (read from `state.getTestModules()`) include pass/fail counts, duration, and failure details

3. Given a test fails
   When the agent requests details
   Then the server returns the specific failure information

#### Story 2.2: Watch Mode Support
**ID:** `vitest-002`

Implement intelligent watch/incremental mode.

**Acceptance criteria:**
1. Given watch mode is enabled
   When a file changes
   Then only affected tests re-run (via Vitest --changed)

2. Given the system tracks coverage
   When a non-test file changes
   Then the system determines which tests need re-execution

3. Given a fast mode toggle
   When disabled
   Then coverage collection runs with tests

#### Story 2.3: Test Isolation Verification
**ID:** `vitest-003`

Guarantee a clean environment per test file by using Vitest's built-in isolation
(rather than building a bespoke isolation engine).

**Acceptance criteria:**
1. Given the server runs a suite
   When isolation is enabled (`isolate: true`, Vitest default)
   Then each test file runs in a fresh module/environment context

2. Given a suite relies on shared mutable state across files
   When isolation is enabled
   Then cross-file state leakage does not occur

3. Given a project explicitly disables isolation for speed
   When the server runs
   Then it surfaces that isolation is off in the run metadata

### Epic 3: Coverage Intelligence (Phase 1)

> **Feasibility note:** Per-test coverage attribution is *not* produced by a standard
> coverage report. It is built from runtime coverage (run test files with V8 precise
> coverage, snapshot cumulative coverage after each file, diff to attribute execution).
> Granularity is test-file level, not individual test case. See `docs/patterns.md`
> (Coverage-to-Test Mapping Pattern). Vitest `--changed` (static import graph) is used
> as a complementary fast pass; the two selections are unioned to avoid misses.

#### Story 3.1: Git-Aware Delta Selection
**ID:** `coverage-000`

Use git diff to select an initial candidate set of affected test files.

**Acceptance criteria:**
1. Given a git diff against the base
   When a run is requested in incremental mode
   Then Vitest `--changed` selects test files affected via the static import graph

2. Given a changed file is not represented in the map
   When selection runs
   Then the system falls back to running the full suite (no silent skip)

#### Story 3.2: Coverage Tracking
**ID:** `coverage-001`

Build and maintain a reverse map of source file → test files that execute it, from
runtime coverage. The single-pass V8 snapshot-diff attribution algorithm is ported/vendored
from `testpick` (MIT — retain its license notice) and adapted to run inside our per-project
worker; setup-baseline subtraction is added by us.

**Acceptance criteria:**
1. Given no coverage map exists
   When a full run executes with V8 coverage
   Then a source-file → test-file map is generated (via per-file snapshot diffing) and persisted on disk keyed by `projectId`, surviving daemon restarts

2. Given a coverage map exists
   When a source file changes
   Then the system identifies dependent test files from the map

3. Given specific test files changed
   When the run completes
   Then only those files are re-measured and the map is updated incrementally

4. Given `setupFiles` run before every test (spike finding)
   When the map is built
   Then a setup-only baseline is measured once and subtracted from each test's attribution, and setup-baseline modules are recorded as full-suite triggers rather than per-test edges

5. Given a test file cannot be measured (timeout/crash/no coverage — e.g. heavy AG-Grid tests)
   When the map is built
   Then that test is recorded as "unknown deps" and always selected on any relevant change (never silently dropped)

> **Spike note (`spike/coverage-map/FINDINGS.md`):** validated on the target repo. The map
> is built **single-pass** (serial, one process, snapshot-diff) — naive per-file was ~6×
> slower. Setup-baseline subtraction is what makes selection useful: without it a common-lib
> edit re-runs the whole suite; with it, ~6% (unit) / ~18% (integration) of the suite.

#### Story 3.3: Smart Re-run Decisions
**ID:** `coverage-002`

Decide what to re-run by unioning the coverage-map and git-delta selections.

**Acceptance criteria:**
1. Given only test files changed
   When the change occurs
   Then only those specific test files re-run

2. Given source files changed
   When the change occurs
   Then dependent test files re-run based on the union of coverage-map and static-graph selection

3. Given a changed file is unknown to the map
   When requested
   Then the system conservatively runs the full suite rather than risk a missed failure

### Epic 4: Output & Status (Phase 1)

#### Story 4.1: Dry Run Mode
**ID:** `dryrun-001`

Enable queuing tests without executing them, via a plan the agent can inspect then commit.

**Acceptance criteria:**
1. Given `run_tests({ projectId, dryRun: true })`
   When the plan is computed
   Then the server returns a `TestPlan` (`planId`, selected files, reasoning, `expiresAt`) without executing

2. Given a valid, unexpired `planId`
   When the agent calls `run_tests({ projectId, planId })`
   Then the server executes exactly the planned files and returns a `TestResult`

3. Given an expired or unknown `planId`
   When commit is attempted
   Then the server returns a `PlanExpired` error and the agent re-plans

#### Story 4.2: Minimal Output Format
**ID:** `output-001`

Structure test output for AI consumption.

**Acceptance criteria:**
1. Given tests run
   When output is generated
   Then only failures are included in summary

2. Given the agent requests details
   When a specific failure is queried
   Then the server returns stack trace, assertion message, etc.

3. Given tests complete
   When results are returned
   Then the format is consistent JSON with metadata

#### Story 4.3: Status Endpoint
**ID:** `output-002`

Provide status checking capability.

**Acceptance criteria:**
1. Given tests are running
   When status is queried
   Then the server returns current state (idle, running, complete)

2. Given tests are complete
   When status is queried
   Then the server returns final results

3. Given an error occurred
   When status is queried
   Then the server returns error details

### Epic 5: Human Monitoring UI (Phase 2)

> Deferred to Phase 2. The UI is pure convenience over the MCP server and is where
> genuine real-time push (SSE/WebSocket) belongs — the MCP stdio channel is
> request/response and is not the streaming transport.

#### Story 5.1: HTTP Status Endpoint
**ID:** `ui-001`

Expose test status via HTTP for human monitoring.

**Acceptance criteria:**
1. Given the server starts
   When the HTTP port is configured
   Then the server listens on the configured port

2. Given the UI endpoint is accessed
   When the page loads
   Then it displays test status in real-time

3. Given tests are running
   When new events occur
   Then the UI updates without refresh (WebSocket or SSE)

#### Story 5.2: Real-time Updates
**ID:** `ui-002`

Implement live test result streaming.

**Acceptance criteria:**
1. Given tests are running
   When a test completes
   Then the UI receives the result immediately

2. Given many tests are running
   When the stream is active
   Then the UI remains responsive

3. Given the connection drops
   When reconnected
   Then the UI shows latest known state

## Technical Constraints

1. **Node.js + TypeScript**: Primary implementation language
2. **MCP SDK**: Use the official `@modelcontextprotocol/sdk` (v1 stable) — `McpServer` + `registerTool` from `.../server/mcp.js`, `StdioServerTransport` from `.../server/stdio.js`. (v2 `@modelcontextprotocol/server` is beta; opt in deliberately if adopted.)
3. **Vitest API**: Use the `vitest/node` programmatic API (`startVitest` / `createVitest`), never CLI output parsing. Pin the Vitest version — the advanced API signature differs between 3.x and 4.x, and `runTestFiles` requires 4.1+.
4. **Platform**: macOS first (Phase 1); Linux and Windows added in Phase 2.
5. **Transport**: Streamable HTTP daemon (`StreamableHTTPServerTransport`, stateful sessions) in Phase 1, with an optional stdio single-project mode; the Phase 2 UI adds its own SSE/WebSocket push channel on top of the daemon's HTTP layer.
6. **Singleton daemon**: One instance per system, enforced via lockfile + known port in the central dir; `test-mcp register` auto-boots it locally (skippable in CI via `--no-spawn`).
7. **Execution isolation**: Tests run in per-project worker subprocesses (CWD = project root) using project-local `vitest`; the daemon process never imports a project's Vitest.
8. **State layout**: Per-project state in `<git-root>/.test-mcp/` (configurable, git-ignored on init) holding `config.json` (`projectId`, `stateDir`), coverage map, and history; daemon-global registry/pid/lockfile in a central dir (e.g. `~/.test-mcp/`), never inside a project.
9. **Performance**: Add minimal overhead to test runs.
10. **Third-party attribution**: the coverage-attribution logic is vendored from `testpick`
    (MIT). Retain its copyright + MIT license text (e.g. a `NOTICE`/`THIRD_PARTY_LICENSES`
    file and a header on the vendored module). Track upstream for fixes.

## Technical Feasibility

See `docs/architecture.md` for the component spine, contracts, and IPC/state schemas.
Validated against current published APIs (July 2026):

- **MCP server & tools** — fully supported. Tools are advertised automatically on
  `registerTool`; input is validated against a Zod schema; `outputSchema` provides
  structured results. No custom protocol handling required.
- **On-system daemon (Streamable HTTP, multi-project)** — fully supported.
  `StreamableHTTPServerTransport` with `sessionIdGenerator` gives stateful sessions;
  the daemon keeps a session→transport map behind an HTTP endpoint (`/mcp` POST/GET/DELETE).
  Project registration and per-project state are ordinary application logic on top.
- **Vitest programmatic runs & coverage** — fully supported via `vitest/node` with the
  v8 coverage provider.
- **Git-aware delta (`--changed`)** — supported, but walks only the **static** import
  graph; it misses runtime/DI/dynamic-import edges and is not persistent. Used as a
  fast pass, unioned with the coverage map, with full-suite fallback for unknown files.
- **Per-test coverage mapping** — **not** available from a standard coverage report.
  Feasible but non-trivial: build it from runtime coverage by snapshotting cumulative
  V8 coverage after each test file and diffing. Granularity is test-file level. This is
  the main build risk. It is proven feasible (the spike, and shipping tools like
  `testpick`), so it is table-stakes rather than a unique differentiator — see
  Competitive Landscape & Positioning.
- **Real-time streaming over MCP** — **not** a stable capability. MCP `tools/call` is
  request/response; incremental partial results are proposal-stage. Phase 1 uses
  progress notifications + a pollable status tool; genuine push streaming lives in the
  Phase 2 HTTP/SSE UI.

## Success Criteria

- **Dry run latency**: Test plan generation <5 seconds for typical projects
- **Incremental runs**: Fast enough for interactive development
- **Precision**: High accuracy in selecting which test files need re-running
- **Coverage mapping**: Reverse dependency map buildable within one full instrumented run
- **Correctness**: No actual failures missed due to intelligent skipping (conservative full-suite fallback whenever selection is uncertain)
- **Adoption**: Teams successfully adopt the system into their workflow

---

## Success Metrics (Aspirational Targets)

Directional goals to steer the work; exact thresholds should be reconfirmed per project
during implementation:

- Incremental runs <15 seconds for single-file changes
- High precision in determining which test files need re-running (target 99%+)
- Selection footprint (after setup-baseline subtraction) materially below full-suite — spike measured ~6% of suite for unit-file changes and ~18% for integration-file changes on the target repo; exact ratio is project- and change-dependent
- Reverse coverage map covering the large majority of suites within one full run (target 95%+)
- Teams replacing their existing test-running setup over time (target 80%+ within 6 months)

> Note on "zero false negatives": guaranteeing 100% recall *and* aggressive skipping is
> not achievable in the general case (a coverage map cannot see a not-yet-executed
> branch). The system therefore prioritises recall over precision — when selection is
> uncertain it runs the full suite — accepting some wasted runs to avoid missed failures.
