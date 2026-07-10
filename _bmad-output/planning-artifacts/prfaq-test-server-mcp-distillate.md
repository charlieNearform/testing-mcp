---
title: "PRFAQ Distillate: test-server-mcp"
type: llm-distillate
source: "prfaq-test-server-mcp.md"
created: "2026-07-10"
purpose: "Token-efficient context for downstream PRD/architecture decisions"
---

## Competitive intelligence (NEW — 2026-07-10 research; not in original PRD)
- `testpick` (github TwistTheoryGames/testpick): coverage-based selection for Vitest+Jest; single-pass sharded V8 precise-coverage delta attribution; `explain` (no black box); errs toward running more (recall-first); monorepo per-package. **This is our Epic 3 engine, already shipping (v0.1).**
- `vitest-agent` (github spencerbeggs/vitest-agent): Vitest plugin + reporter + CLI + **MCP server** + Claude Code plugin; persists runs to SQLite (XDG path); exposes status/coverage/failure-history/trends over CLI+MCP. **Our MCP+persistence concept, already shipping.**
- `vitest-affected` (github craigvandotcom/vitest-affected): runtime reverse-dependency map, ~5ms selection, persistent cache `.vitest-affected/graph.json`, explicitly targets parallel AI agents.
- `djankies/vitest-mcp` and `@madrus/vitest-mcp-server`: AI-optimized Vitest MCP runners (structured output, coverage, multi-repo, safety guards).
- Native **`vitest --stale`** proposed (vitest issue #9917): mtime-based, git-free, agent-targeted incremental selection. If it lands, covers the simple single-project case.
- Confirmed pain point (dev.to kazutaka + testpick + vitest-affected): `vitest --changed`/`jest --findRelatedTests` walk STATIC import graph → miss registry/DI/dynamic-import edges → worst-case silent skip of a breaking test. Coverage-based (runtime) selection is the known fix.

## Differentiation — reframed (ACTION for PRD)
- Original docs imply the differentiator is "coverage-based reverse-map selection." **No longer true** — reframe.
- Durable wedge = the combination: (1) single always-on daemon serving MANY projects over Streamable HTTP; (2) project-local execution — each project's own Vitest version in an isolated worker (monorepo/version-skew safe); (3) transparent repo-local `.test-mcp/` state (not a hidden SQLite DB); (4) setup-file baseline subtraction as first-class correctness.
- This is a feature wedge, not a moat — competitors could add a daemon mode.

## Strategic decision (RESOLVED 2026-07-10)
- Coverage engine sourcing: **vendor testpick's MIT V8 snapshot-diff attribution algorithm into our own worker** — not CLI-wrap (testpick is a CLI that owns the run, no API, v0.1 dep), not full-scratch. Add setup-baseline subtraction ourselves; retain testpick MIT license notice (NOTICE/THIRD_PARTY_LICENSES + module header). Epics 1/2/4 = original contribution.
- Positioning: reframed around the daemon/isolation/transparency wedge; propagated to docs/prd.md, SPEC.md (Intent + C9 + constraint), ARCHITECTURE-SPINE.md (AD-9 + new AD-11), epics.md (Story 3.2), readiness report.

## Requirements signals reaffirmed
- Recall-first: full-suite fallback on any uncertainty (unknown/new file, setup-baseline module, unmeasurable test). Do not claim absolute "zero false negatives."
- Union coverage-map selection with static `--changed` graph (each covers the other's blind spot: coverage misses not-yet-run branches; static misses runtime/DI edges).
- Unmeasurable/heavy tests (AG-Grid, integration) → always-run, never dropped.
- Coverage map must be single-pass (naive per-file ~6× slower per spike).

## Scope (in/out) — confirmed
- IN (P1): daemon+registration, project-local worker execution, dry-run plan/commit, status/output, coverage selection + baseline subtraction + fallback + watch.
- OUT: Jest/pytest (testpick already covers Jest — cite as "use testpick if Jest"), human UI (P2), priority scoring/health (P2), fixture-time tracking / ordering-dependency detection / resource-contention quotas (research-grade, deferred), cross-platform beyond macOS (P2).

## Risks / what kills it (from Internal FAQ)
- Native `--stale` ships and is "good enough" for single-project majority.
- `vitest-agent`/`testpick` add daemon/multi-project mode before we ship → wedge erased. → ship daemon wedge FAST.
- One early high-profile missed failure burns trust → keep recall-first fallback loud + default.
- Low blast radius (OSS, no user data, no infra); real cost is opportunity (re-implementing solved core).

## Verdict
- Rating: **needs-heat** with a foundational crack on differentiation. Proceed, but reframe around the daemon wedge and make Epic 3 integrate-first. Not a kill.

## Open questions for the user
- Licensing choice for our own OSS release (permissive assumed; must be MIT-compatible to include vendored testpick code).
- Confirm the exact provenance/version of testpick source vendored, and set up an upstream-tracking reminder for fixes.
