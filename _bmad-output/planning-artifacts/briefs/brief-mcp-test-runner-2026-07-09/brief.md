---
title: "MCP Test Runner"
status: draft
created: 2026-07-09
updated: 2026-07-10
---

# Product Brief: MCP Test Runner

## Executive Summary

An intelligent test orchestration server that provides programmatic test running capabilities for JavaScript/TypeScript projects. Built as a Model Context Protocol (MCP) server, it delivers intelligent test selection, real-time result streaming, and structured output optimized for AI agents and CI/CD pipelines. Unlike traditional test runners that force full-suite executions, this system intelligently determines which tests need re-running based on code changes, dramatically reducing feedback cycles while maintaining reliability.

The core insight is that test running shouldn't be about executing everything—it should be about executing the right tests at the right time. By combining coverage analysis, git-aware delta detection, and priority scoring, the system eliminates wasteful re-runs while ensuring nothing slips through the cracks.

## The Problem

Current test running workflows suffer from several fundamental inefficiencies:

1. **Exhaustive re-runs**: Every change triggers a full suite execution—even when only one file changed. Teams running 5,000+ tests face 2-3 minute feedback cycles on fast machines, 15-20 minutes on slower ones.

2. **No intelligent caching**: Running tests after small changes re-runs the entire suite because there's no systematic way to track which tests depend on which code.

3. **Information overload**: In large test suites, finding failures buried in thousands of passing tests is difficult. Verbose output makes debugging slow and error-prone.

4. **AI integration gap**: LLM agents and automated workflows cannot programmatically trigger tests, query results, or get structured output suitable for programmatic consumption.

5. **No visibility during execution**: Developers and CI systems lack clear status indicators showing whether tests are running, passing, or failing in real-time.

## The Solution

A Model Context Protocol server that provides intelligent test orchestration:

- **Intelligent test selection**: Uses git deltas, coverage mapping, and priority scoring to determine exactly which tests need re-running—never execute more than necessary.

- **Dry run mode**: Queue tests without executing, allowing AI agents to evaluate what would run before committing to execution after an iteration completes.

- **Structured output**: Minimal, hierarchical output focused on failures with progressive disclosure—start with pass/fail counts, expand only on request.

- **Progress + status**: MCP progress notifications give coarse status during a run, with a pollable status tool for current state. (True per-test push streaming is a Phase 2 concern delivered via the HTTP/SSE UI — MCP `tools/call` is request/response.)

- **Test health monitoring** (Phase 2): Track reliability scores, flakiness, performance trends, and ownership metadata for every test.

The system runs as a **single persistent on-system daemon** (Streamable HTTP). Rather than
invoking `vitest` directly, an AI agent **registers a project** (any directory with a
vitest/vite config) via a thin `test-mcp` CLI — which auto-boots the daemon if needed —
then orchestrates all test activity through MCP tools scoped by `projectId`. One daemon
serves many projects; it executes each project's tests in an isolated worker subprocess
using the *project's own* Vitest. Per-project intelligence (coverage map, run history)
persists in a git-ignored `.test-mcp/` folder in the repo (visible, not a black box),
while the daemon's own registry lives centrally, so nothing pollutes project source.

The system has two layers:
1. **Core MCP Server**: The on-system daemon — programmatic interface for AI agents and CI/CD pipelines—the primary product
2. **Human UI**: Optional web interface built on top of the MCP server for human developers

## What Makes This Different

| Aspect | Traditional Runners | This Solution |
|--------|---------------------|---------------|
| Selection | Full suite only | Intelligent delta + priority |
| Output | Verbose console | Structured JSON with progressive disclosure |
| Integration | CLI only | MCP protocol for programmatic access |
| Feedback | Post-execution | Real-time streaming |
| AI-friendly | No | Native |

The unfair advantage is the combination of three elements working together: (1) git-aware delta testing that understands code relationships, (2) priority scoring informed by historical failure patterns, and (3) dry run mode specifically designed for AI agent workflows. Most solutions focus on one of these; this integrates all three into a cohesive system.

## Who This Serves

**Primary Users:**
- **AI Agents**: Need programmatic test triggering, structured results, and the ability to evaluate test impact before committing to execution
- **CI/CD Pipelines**: Require reliable, fast test execution with intelligent caching and minimal resource waste

**Secondary Users:**
- **Human Developers**: Benefit from the optional web UI showing test status, health metrics, and failure details
- **Engineering Managers**: Use health dashboards to identify flaky tests, slow tests, and coverage gaps

## Success Criteria (Aspirational Targets)

Directional goals; exact thresholds reconfirmed per project during implementation.

- **Feedback cycle reduction**: Incremental runs complete in under 15 seconds for single-file changes
- **Accuracy**: High precision in selecting which test files need re-running (target 99%+)
- **Coverage**: Reverse coverage map buildable for the large majority of suites within one full run (target 95%+)
- **Reliability**: No actual failures missed due to intelligent skipping — the system prioritises recall and falls back to the full suite whenever selection is uncertain (100% recall + aggressive skipping is not simultaneously guaranteed)
- **Adoption**: Most target teams replace their existing test-running setup over time (target 80%+ within 6 months)

## Scope

Authoritative phasing lives in `docs/prd.md#phasing`; this section mirrors it.

**In Scope (Phase 1):**
- Single persistent on-system MCP daemon (Streamable HTTP) with runtime project registration (`register_project` / `list_projects`)
- Thin `test-mcp` CLI (`init` / `register` / `start` / `stop` / `status`) with singleton enforcement and local auto-boot
- Per-project state (coverage map + history) in a git-ignored `.test-mcp/`; daemon registry central
- Core MCP server tools for test running (`@modelcontextprotocol/sdk` v1)
- Vitest integration via the `vitest/node` programmatic API, run in per-project worker subprocesses using project-local Vitest
- Test isolation via Vitest's built-in isolation
- Git-aware delta selection (Vitest `--changed`, static import graph)
- Coverage-based reverse-dependency mapping (built from runtime coverage — the differentiator)
- Structured JSON output with progressive disclosure
- Dry run mode for queuing tests without executing

**Phase 2:**
- Priority scoring based on git recency and failure history
- Test health monitoring / dashboard
- Human web UI with real-time (SSE/WebSocket) updates
- Cross-platform (Linux/Windows) support

**Out of Scope (early phases):**
- Jest or pytest support
- Priority-based sharding
- IDE integration
- Trend analytics
- Suggested fixes for failures

**Explicitly Deferred (research-grade):**
- Advanced dependency graph visualization
- Priority-based parallelization optimization
- Flaky test auto-isolation
- Fixture/setup-time cost tracking, ordering-dependency detection, parallel resource-contention quotas
- Code snippet extraction for debugging

## Vision

Three years from now, this becomes the standard way JavaScript/TypeScript projects run tests—not as a CLI tool developers invoke manually, but as an intelligent service embedded in the development workflow. AI agents automatically determine test strategy, CI pipelines optimize resource usage through intelligent selection, and developers get instant feedback on their changes without waiting for full suites.

If successful, the system expands beyond JavaScript to support Python (pytest) and other ecosystems, becoming the universal intelligent test orchestrator for modern software development.
