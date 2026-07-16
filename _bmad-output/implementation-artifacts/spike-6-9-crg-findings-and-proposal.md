---
title: 'Story 6.9 — CRG impact analysis: spike findings & scoping proposal'
type: 'spike'
created: '2026-07-15'
status: 'spike-complete — build deferred by decision 2026-07-16'
---

> **DECISION (2026-07-16): build deferred.** The spike is complete and its findings stand; the CLI
> seam was verified insufficient and the viable seams (pooled MCP client, or SQLite) are heavier
> than the lightweight integration originally scoped. 6.9 is parked here — pick it up as planned
> work when CRG-backed selection is prioritized, starting from the "seam + plumbing vs full B vs C"
> options above. No product code was written.


# Story 6.9 — CRG-backed impact analysis: spike findings & proposal

**This is a proposal for sign-off — no product code has been written.** Per the story's escalation
trigger ("introduces an optional external-tool dependency … confirm the seam with the architecture
spine before building"), this brings back grounded findings from a live spike against the CRG MCP
tools on this repo, and proposes a design + the decisions I need from you before implementing.

## What I probed (live, against this repo)

- `list_graph_stats` → the graph is real, local, multi-language: **156→178 files, ~1800 nodes,
  ~20.5k edges**, node kinds `File / Class / Function / Test` (498 Test nodes), edge kinds incl.
  **`TESTED_BY` (2.6k edges)**, `CALLS`, `IMPORTS_FROM`. So CRG has a native source↔test relationship.
- `get_impact_radius(changed_files=[…], detail=standard)` on a **fresh** graph for 2 changed source
  files → **20 changed nodes, 489 impacted (2 hops), 128 impacted files including 5 `*.test.ts`
  files**. So CRG genuinely resolves a change → the affected test files. The payoff is real.
- Node identity: nodes are keyed by **absolute path** (`file_path` / `qualified_name`, e.g.
  `/Users/…/src/worker/index.ts`) with an `is_test` boolean, `kind`, and `line_start/end`.

## The three findings that shape the design

1. **Staleness is decisive AND silent.** The graph's `last_updated` was hours stale (auto-watch had
   NOT kept it current). On the stale graph, `get_impact_radius` auto-detecting the last commit's
   diff returned **0 changed nodes / 0 impacted** — a silent empty signal. Only after an explicit
   `build_or_update_graph_tool(full_rebuild)` did it return the rich 489-node result. ⇒ A stale CRG
   graph looks identical to "nothing is affected." If test-mcp ever trusted that to *narrow*
   selection, it would silently **under-select**. This is the single most important constraint.

2. **CRG must only ever ADD to selection, never shrink it** (AC3, now proven necessary). CRG's
   blast radius is a *static* graph — it cannot see the dynamic/runtime coupling the coverage map
   (B) catches, and when stale it returns too little. So the only safe use is: **union** CRG's
   affected test files into the existing selection (coverage-map B ∪ git `--changed` A ∪ CRG),
   exactly like the existing union. CRG can *raise* confidence (an extra corroborating signal) but a
   thin/empty CRG result must **never lower** the set or the confidence below the non-CRG baseline.

3. **Addressing needs care.** `tests_for`/`file_summary` did NOT resolve a project-relative *file
   path* target (they want a node name/qualified-name), but `get_impact_radius(changed_files=…)`
   accepts relative paths and returns absolute `impacted_files` we can filter by `is_test` / the test
   convention. ⇒ The clean entry point is **`get_impact_radius` (changed files in, impacted test
   files out)**, not the node-name queries; and test-mcp must resolve relative↔absolute paths.

## Proposed design

A **provider seam** in `src/selection` — the static-graph signal gets two implementations behind one
interface: the existing Vitest `--changed` (default, always available) and an optional CRG provider
used only when detected, fresh, and fast. `SelectionEngine.plan` stays pure; the provider does I/O.

```
interface ImpactProvider {
  name: "vitest-changed" | "crg";
  available(projectRoot): boolean;              // cheap, safe probe; absence is the common case
  affectedTestFiles(projectRoot, changedFiles): { tests: string[]; fresh: boolean } | null;  // null => unusable
}
```

- **Union, never replace:** CRG's `tests` are unioned into the worker's run set alongside coverage-map
  (B) + git `--changed` (A). A `null`/empty/stale CRG result changes nothing (falls back to today's
  behavior). Selection can only grow.
- **Staleness guard (load-bearing):** before trusting CRG, compare the graph's `last_updated` (from
  `list_graph_stats`) against the working tree / HEAD; if the graph is older than the changes (or the
  changed files aren't in the graph), treat CRG as **unavailable** and fall back — never narrow.
- **Confidence (6.8):** when CRG corroborates (fresh graph, changed files present, its affected tests
  ⊆ the tests we're already running), it can push a `degraded` toward `high` and the selection reason
  (6.4) notes "CRG blast-radius corroborated". When CRG is stale/absent, confidence is unchanged.
- **Lazy, per-project, never at import/startup.** The daemon must not hard-require CRG.

### Seam options (the main decision I need)

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. CLI shell-out** (recommended *if* a JSON CLI exists) | `code-review-graph impact --changed-files … --json` as a subprocess, like we already shell to git/vitest | Isolated, no long-lived connection, graceful absence (command missing → fallback), matches existing subprocess pattern, zero new runtime deps | **Unconfirmed** that CRG exposes a JSON-emitting CLI `impact`/`detect-changes` command (I only verified the MCP-server tools). Needs a quick check. |
| **B. Daemon as MCP client** | daemon opens an MCP client to `uvx code-review-graph serve` and calls `get_impact_radius` | Uses the exact interface I proved works | Heaviest: the daemon must manage an MCP client + the CRG server lifecycle; new architectural surface (daemon-as-client); latency/handshake; more failure modes |
| **C. Direct SQLite read** | read `.code-review-graph/graph.db` and query TESTED_BY / impact | Fast, no process mgmt | Couples to CRG's DB schema (brittle across CRG versions); reimplements blast-radius traversal |

My recommendation: **A if the CLI can emit impact JSON; otherwise B**, kept behind the provider seam
so the choice is swappable. C is a last resort (schema coupling).

## Scope for a first, safe increment (if approved)

1. Provider seam + the Vitest-`--changed` provider extracted behind it (no behavior change).
2. A CRG provider: probe availability + **freshness**, call impact (via the chosen seam), map
   impacted files → test files (`is_test`/convention, abs→rel), return them. Fail closed to `null`.
3. Union into the run set; reason + confidence notes. **Never shrink selection or confidence.**
4. Tests: hermetic — a fake provider (no real CRG) for the union/confidence logic; a guarded
   integration test skipped when CRG isn't installed.

Deliberately **out of the first increment:** per-function/per-spec selection, auto-building/updating
the user's CRG graph, and bundling CRG.

## Decisions I need before building

1. **Seam:** confirm **A (CLI shell-out)** — and I'll first verify a JSON CLI exists; if not, fall
   back to **B (MCP client)**? Or do you want B outright / C ruled in?
2. **Freshness policy when the graph is stale:** (a) silently fall back to non-CRG (my default), or
   (b) also surface a hint ("CRG graph stale — run `code-review-graph build` for richer selection")?
   test-mcp will **not** auto-build the user's graph in the first increment.
3. **Confidence direction:** CRG only ever *raises* confidence / *adds* tests, never lowers — confirm
   that's the intended semantics (it's the only safe reading given finding #1).

Note: the spike left the local `.code-review-graph/` graph freshly rebuilt (it's git-ignored — no repo impact).

## UPDATE (2026-07-15) — CLI seam VERIFIED INSUFFICIENT; seam re-decision needed

Sign-off was: **A (CLI shell-out), verify first; else fall back to B (MCP client)**. Verified:

- CRG's CLI has no `impact` command. The closest is **`detect-changes`** (`uvx code-review-graph
  detect-changes --base <ref> --repo <root>`), which emits JSON by default, read-only. Its keys:
  `changed_functions`, `affected_flows`, `test_gaps`, `review_priorities`, `risk_score`, `summary`.
- **It does NOT return the blast-radius → affected *test files* that AC1 needs.** The only test-file
  paths in its output are the *changed* test files themselves, not tests that *cover* the changed
  sources. `changed_functions` entries carry no covering-tests field; there is no `impacted_files`.
- That capability — `impacted_files` filtered by `is_test` — exists **only via the MCP
  `get_impact_radius` tool** (which I proved returns the 5 affected test files), not the CLI.

So **seam A is ruled out** for AC1. The remaining options and their *true* cost:

- **B — MCP client.** Achievable with **no new dependency** (the daemon already depends on
  `@modelcontextprotocol/sdk`, which ships a `Client` + `StdioClientTransport`). BUT `serve` loads
  the whole graph into memory at startup, so spawning it per selection (cold `uvx` + graph load) is
  **seconds of latency on every incremental run** — which would defeat the "fast incremental" value.
  Making it usable needs a **pooled, long-lived CRG server + client per project** — real lifecycle
  management inside the daemon (spawn, health, staleness, teardown). That is the "notable
  architectural change" the story's escalation trigger names.
- **C — direct SQLite read** of `.code-review-graph/graph.db` (nodes + `TESTED_BY`). Fast, no
  process/handshake — but Node 20 (the repo's floor) has **no built-in SQLite**, so it needs a new
  runtime dep (`better-sqlite3`) AND couples to CRG's DB schema. Two strikes.

**Recommendation:** the honest first increment is **B with a pooled long-lived client**, but that is
materially heavier than the git-style shell-out that was signed off, so it warrants re-confirmation
before building. A cheap intermediate: build the **provider seam + a fake/stub provider + all the
union/confidence/reason plumbing and tests now** (pure, no CRG process), and land the real CRG
transport (pooled MCP client) as a focused follow-up once the lifecycle approach is confirmed.
