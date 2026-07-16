---
title: "Runner Plugin API"
status: draft
created: 2026-07-16
updated: 2026-07-16
---

# Product Brief: Runner Plugin API

## Executive Summary

test-server-mcp's entire value proposition — incremental test selection, coverage-gated confidence, a persistent daemon driven by an AI agent via MCP — is currently welded to one test runner. `src/worker/index.ts` imports Vitest's programmatic `vitest/node` API directly; git-aware selection assumes Vitest's own `--changed` flag; coverage assumes Vitest's `coverage.thresholds` config shape. None of that is a limitation of the *idea* — it's an artifact of building the first, working version against the one runner already in front of us.

This brief proposes extracting that Vitest-specific logic behind a **RunnerPlugin** interface, so the daemon's selection/coverage/confidence machinery becomes runner-agnostic, with Vitest as its first (and, for this brief, only production-grade) implementation. Jest becomes a second plugin — not to reach feature parity, but to prove the seam holds under a real second runner rather than a hypothetical one. Alongside this, a project-registration gap surfaces once the one-runner-per-project assumption breaks down: real projects commonly run multiple distinct suites (Vitest for unit tests, Playwright for e2e) that need to be registered, selected, and reported on independently.

The near-term goal is narrow and deliberately sequenced: **make plugins possible before making more plugins.** Everything beyond that — pytest, `go test`, a generic subprocess/Docker escape hatch for non-JS ecosystems — is real; the original product brief's own Vision section already named "expand beyond JavaScript" as the long-term arc (`brief-mcp-test-runner-2026-07-09/brief.md`). But it's explicitly out of this brief's scope until the seam is proven.

## The Problem

1. **The runner is hardcoded, not abstracted.** `startVitest`/`createVitest` calls are inline in the worker, not behind an interface. Adding any other runner today means duplicating — not reusing — the selection, coverage, and confidence machinery per runner.
2. **"One runner per project" doesn't match reality.** A project with a Vitest unit suite and a Playwright e2e suite can't register both today; the registry model assumes a single test surface per project.
3. **Coverage is assumed available and Vitest-shaped.** The confidence model (`high`/`degraded`) and the 100%-threshold gate both assume V8/Istanbul-shaped coverage exists. A runner that can't produce coverage at all (e.g. a visual-regression or Docker-based suite) has no defined behavior in the current model — it isn't "degraded," it's undefined.

## The Solution

**A `RunnerPlugin` interface**, modeled on the same seam pattern already proposed elsewhere in this codebase (the Story 6.9 CRG spike's `ImpactProvider`: optional, probed for availability, unions in, never narrows, fails closed):

```ts
interface RunnerPlugin {
  name: string;                 // "vitest", "jest"
  detect(projectRoot): boolean; // cheap probe: config file / manifest presence
  capabilities: {
    coverage: "none" | "summary" | "line-hit";
    changedFileDetection: boolean;
    watch: boolean;
  };
  listTestFiles(projectRoot): Promise<string[]>;
  run(projectRoot, testFiles: string[], opts: { coverage?: boolean }): Promise<NormalizedResult>;
  affectedTests?(projectRoot, changedFiles: string[]): Promise<string[] | null>;
  readCoverageThresholds?(projectRoot): Promise<Thresholds | undefined>;
}
```

Vitest becomes the first implementation, extracted from the worker **with no behavior change** — same pattern as extracting `--changed` behind `ImpactProvider` before adding CRG as a second source. Jest becomes the second, once the seam is proven — validating that the interface, not just its one occupant, is sound.

**Coverage as a graded, optional capability**, not an assumption: `capabilities.coverage` is `"none"` (no coverage possible — the confidence/threshold machinery is skipped, not degraded), `"summary"` (per-run percentages only, no cross-run union), or `"line-hit"` (full 6.10-style combined-coverage merge). A plugin that can't do coverage doesn't produce a worse answer — it produces no coverage answer, which the daemon must represent as a distinct third state alongside the existing `high`/`degraded` confidence axis. A genuine cross-runner coverage merge format (something lcov-shaped, per the research below) is explicitly a *later* increment — this brief's scope is graceful absence, not universal merging.

**Multi-suite-per-project registration.** A project registers one or more named suites, each bound to its own plugin instance (e.g. `unit` → vitest, `e2e` → playwright). Selection, run history, and coverage become scoped per suite, not just per project. `test-mcp register` uses auto-detection of plugins' config markers (`vitest.config.*`, `playwright.config.*`, etc.) as the primary path, with an optional explicit suite definition a user can supply when auto-detect fails or picks the wrong plugin — auto-detection isn't the only path in.

## What Makes This Different

Pluggable test runners aren't a new idea — the honest framing matters here. Prior art review (see `addendum.md`) found:

- Jest's own `testRunner` config point is the closest existing analogue — a 1:1 module swap, proven in production by `jest-circus` replacing `jest-jasmine2`. That's the shape this brief takes, not pytest's `pluggy` hook-fan-out model (which suits many-plugins-cooperating, not one-runner-per-suite).
- CTRF (Common Test Report Format) is the best-fitting precedent for a JSON plugin *contract* shape (small required core + optional extensions).
- lcov is genuinely polyglot for coverage — but even **Bazel's own coverage command**, built for polyglot orgs, only cleanly handles LCOV-emitting runtimes and struggles with Istanbul's JSON. Treating coverage as optional/graded per plugin isn't a shortcut this brief is taking — it's an unsolved seam that more mature tooling than ours hasn't cleanly solved either.
- Neither Bazel nor Nx (the closest polyglot-orchestration peers) treats coverage as an explicit graded-per-plugin capability. That combination — lightweight MCP-native daemon (no build-graph adoption cost) + graded coverage — is the actual gap, not "pluggable runners" as a concept.

## Who This Serves

Same primary users as the parent product (AI agents driving test execution via MCP, CI/CD pipelines) — this feature specifically unblocks:
- **Projects with mixed test surfaces** (unit + e2e, or non-JS components) that currently can't be fully represented in test-mcp at all.
- **Future runner authors** (internal or, eventually, external) who need a stable contract to target instead of reading the worker's Vitest-specific internals.

## Success Criteria

- **Zero regression**: after extraction, an existing Vitest-only registered project shows no behavior or output change — same selection decisions, same coverage numbers, full test suite green.
- **Seam validated by a second real runner**: a Jest plugin passes an equivalent hermetic test suite to Vitest's plugin tests, proving the interface — not just Vitest's implementation of it — is sound.
- **Multi-suite registration works end-to-end**: a real project with two suites (e.g. Vitest unit + Playwright e2e) registers both, and `run_tests` can target either independently through existing MCP tools.
- **No-coverage is a defined, correct state**: a plugin declaring `coverage: "none"` never produces a false `thresholdsMet`, never silently claims a confidence level it can't back — the daemon's own "never crash, fail loud and specific" invariant extends to "never claim a capability a plugin doesn't have."

## Scope

*To be reconciled into `docs/prd.md#phasing` once this brief moves to PRD/architecture — this brief doesn't yet claim alignment with that document.*

**In scope (this increment):**
- `RunnerPlugin` interface definition.
- Vitest extracted behind it, zero behavior change (see Success Criteria).
- Multi-suite-per-project registration model (named suites, each bound to one plugin instance) — selection/history/coverage scoped per suite, auto-detected by `test-mcp register` with explicit override (see Solution).
- Jest as a second plugin, scoped to validating the seam (run + basic changed-file detection + whatever coverage capability Jest cleanly supports) — not full feature parity with the Vitest plugin. Scope stays JS-ecosystem-only for this increment.

**Explicitly out of scope (this increment):**
- pytest, `go test`, or any other non-JS runner.
- The generic shell-command/subprocess or Docker-based plugin escape hatch — real, and likely the actual on-ramp for non-JS ecosystems eventually, but scoped out as its own later discovery task (container lifecycle, cold-start latency vs. the "fast incremental" value proposition need their own design pass).
- A universal cross-runner coverage merge format (lcov-shaped or otherwise) — this increment's coverage bar is "each plugin reports its own capability honestly," not "coverage merges cleanly across runner types."
- Function-level test selection. Raised in the same conversation this brief originated from, but it's an unrelated gap — tracked separately (most likely addressed, if ever, by the parked CRG/Story 6.9 work). This may stay permanently out of scope rather than just deferred: few runner plugins would likely be able to support that granularity even if built, so it isn't treated as a natural "later increment" of this brief.

## Vision

If the seam holds under Jest, the architecture question is settled and the remaining work becomes additive: a pytest plugin, a generic subprocess/Docker plugin as the true polyglot on-ramp, and eventually the cross-runner coverage merge this increment deliberately defers. That's the same "expand beyond JavaScript" arc the original product brief already named — this is the increment that makes it architecturally possible instead of aspirational.
