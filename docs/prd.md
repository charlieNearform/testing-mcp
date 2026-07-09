# Product Requirements Document

## Overview

Build an MCP (Model Context Protocol) server that provides intelligent test running capabilities for JavaScript/TypeScript projects, specifically optimized for Vitest but designed to support multiple test runners (Jest, pytest) in the future.

### Problem Statement

Current test running workflows have several pain points:

1. **Long feedback cycles**: 2-3 minute full test suites on fast machines, 15-20 minutes on slower machines
2. **No intelligent caching**: Running tests after small changes re-runs the entire suite
3. **Verbose output**: Hard to quickly identify failures in large test suites (~5,000 tests)
4. **No status visibility**: No clear view into whether tests are running, passing, or failing during execution
5. **AI integration gap**: LLM agents can't programmatically trigger tests or query results

### Solution

An MCP server that:
- Runs tests via configured runners (Vitest first, extensible to Jest/pytest)
- Supports watch/incremental mode based on file changes
- Tracks coverage intelligently to avoid unnecessary re-runs
- Provides minimal, structured output focused on failures
- Exposes status endpoints for monitoring

## User Stories

### Epic 1: Core Infrastructure

#### Story 1.1: Project Setup & Configuration
**ID:** `setup-001`

Set up the basic project structure with configuration via `mcp.json`.

**Acceptance criteria:**
1. Given the project is initialized
   When a user creates `mcp.json` with test suite configuration
   Then the server reads and validates the configuration

2. Given the server starts
   When configuration is loaded
   Then the server advertises available capabilities

#### Story 1.2: Basic MCP Server Implementation
**ID:** `setup-002`

Implement the core MCP server with standard tools.

**Acceptance criteria:**
1. Given the server starts
   When a client connects via stdio
   Then the server advertises test-running tools per MCP spec

2. Given the server receives a `run_tests` tool call
   When the call includes valid parameters
   Then the server executes tests and returns results

3. Given the server receives an invalid tool call
   When validation fails
   Then the server returns proper error response

### Epic 2: Test Runner Integration

#### Story 2.1: Vitest Integration
**ID:** `vitest-001`

Integrate Vitest as the primary test runner.

**Acceptance criteria:**
1. Given a Vitest configuration exists
   When tests are run
   Then the server executes tests via Vitest API (not CLI)

2. Given tests are running
   When the process completes
   Then results include pass/fail counts, duration, and failure details

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

### Epic 3: Coverage Intelligence

#### Story 3.1: Coverage Tracking
**ID:** `coverage-001`

Track which tests cover which files.

**Acceptance criteria:**
1. Given coverage data exists
   When a file changes
   Then the system identifies dependent tests

2. Given no coverage data exists
   When full suite runs
   Then coverage is generated and cached

3. Given cached coverage exists
   When a relevant file changes
   Then the cache is invalidated appropriately

#### Story 3.2: Smart Re-run Decisions
**ID:** `coverage-002`

Make intelligent decisions about what to re-run.

**Acceptance criteria:**
1. Given only test files changed
   When the change occurs
   Then only those specific tests re-run

2. Given source files changed
   When the change occurs
   Then dependent tests re-run based on coverage mapping

3. Given neither changed
   When requested
   Then the system uses cached results

### Epic 4: Output & Status

#### Story 4.1: Minimal Output Format
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

#### Story 4.2: Status Endpoint
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

### Epic 5: Human Monitoring UI

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
2. **MCP SDK**: Use official @modelcontextprotocol/sdk
3. **Vitest API**: Prefer programmatic API over CLI parsing
4. **Cross-platform**: Support macOS, Linux, Windows
5. **Performance**: Add minimal overhead to test runs

## Success Metrics

- Test suite runs complete in <5 minutes even on slow machines
- Incremental runs complete in <30 seconds for single-file changes
- 95%+ accuracy in determining which tests need re-running
- UI latency <1 second for status updates
- Zero false negatives (missed failures)
