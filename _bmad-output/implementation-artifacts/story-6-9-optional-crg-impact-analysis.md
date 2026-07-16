# Story 6.9: Optional CRG-Backed Impact Analysis (use when present)

**ID:** `6-9`
**Slice:** `src/selection` (+ an optional provider seam)
**Type:** `feature` (spike-first)
**Depends on:** `6-6`, `6-7` (selection refinements), and `6-8` (confidence signal) — layers on top
**Status:** backlog — spike complete (see `spike-6-9-crg-findings-and-proposal.md`), build deferred 2026-07-16

## Source

The target project (and potentially others) already runs **code-review-graph (CRG)** — a
local-first Tree-sitter dependency/call graph exposing "blast radius" (what depends on X) over
an MCP server (tools incl. `blast_radius`, `detect_changes_tool`, `query_graph_tool`). Where
CRG is already present, test-mcp may as well use its richer, persistent, language-aware
impact analysis to improve test selection — **without** taking a hard dependency on it.

- Related: `src/selection/index.ts` (static-graph signal "A" = Vitest `--changed`), Story 3.5
  (union + fallback), 6.6/6.7 (selection refinements), 6.8 (confidence signal),
  https://code-review-graph.com / https://github.com/tirth8205/code-review-graph.

## Acceptance criteria

1. **Given** a project where CRG is available (its graph/MCP is present and current)
   **When** an incremental selection is computed
   **Then** test-mcp can use CRG's blast-radius for the changed files to identify affected test
   files, **unioned** with the existing coverage-map (B) selection — improving the static-graph
   signal beyond Vitest `--changed`.

2. **Given** a project where CRG is **not** available (or its graph is stale/unreadable)
   **When** selection runs
   **Then** test-mcp falls back to the existing Vitest `--changed` static graph with **no error
   and no hard dependency** — CRG is strictly optional/enhancing.

3. **Given** CRG's blast-radius is a **static** graph
   **When** it is used
   **Then** it **augments, never replaces**, the runtime coverage map (B), which still catches
   dynamic/runtime coupling CRG cannot see (invariant preserved).

4. **Given** CRG informed a selection
   **When** the result is reported
   **Then** the selection reason (6.4) notes CRG's contribution, and CRG's confidence/coverage
   of the change feeds the confidence signal (6.8).

## Out of scope

- Making CRG mandatory or bundling/installing it (it must be pre-present in the project).
- Replacing the coverage map or the git/since-last-run change detection.
- Per-function / per-spec selection (CRG offers function-level blast radius; test-mcp selects
  test files) — a possible future, not this story.

## Notes for the agent

- **Spike first**: this is exploratory. Open questions to resolve before committing to a design
  — (a) integration seam: does the daemon call CRG's **MCP server** (daemon-as-MCP-client) or
  read its SQLite graph (`.code-review-graph/graph.db`) directly? (b) mapping CRG blast-radius
  nodes → Vitest test files (by test-file convention); (c) graph **staleness** (CRG needs its
  own `build`/`update` — decide how test-mcp detects a stale graph and falls back); (d) latency
  vs. Vitest `--changed`.
- Keep it behind a clean **provider interface** so the static-graph signal has two
  implementations (Vitest `--changed` default; CRG when detected). Detection must be cheap and
  safe — absence is the common case.
- Do **not** let the daemon hard-require CRG at import/startup; probe lazily per project.

## Escalation triggers

- **Introduces an optional external-tool dependency into the daemon** (possibly the daemon
  acting as an MCP client of another server). That is a notable architectural change — confirm
  the seam with the architecture spine before building (keep it optional, isolated, and
  fallback-safe). Bring findings from the spike back before committing to the integration.
