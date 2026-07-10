---
title: "PRFAQ: test-server-mcp"
status: "complete"
created: "2026-07-10"
updated: "2026-07-10"
stage: 5
concept_type: open-source
inputs:
  - docs/prd.md
  - docs/architecture.md
  - _bmad-output/planning-artifacts/prd/prd-test-server-mcp-2026-07-10/SPEC.md
  - _bmad-output/planning-artifacts/architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md
  - spike/coverage-map/FINDINGS.md
---

# Your AI coding agent can run only the tests your change can actually break — across every project on your machine, from one always-on server.

## For developers running AI coding agents: verify each edit in seconds without melting your machine or silently skipping the test that would have caught the bug.

**San Francisco, 2026-07-10** — Today we're releasing **test-server-mcp**, an open-source MCP (Model Context Protocol) daemon that lets AI coding agents run tests intelligently. Instead of shelling out `vitest` and re-running the whole suite after every edit, an agent registers a project once and then asks the daemon to run exactly the tests a change can affect — using that project's own Vitest, with results structured for an agent to act on.

Today, an agent that edits one file has two bad options: re-run the entire suite (minutes per edit, and with several agents in parallel the machine grinds to a halt), or skip testing and hope. Teams pick "skip," and regressions slip through. The existing `vitest --changed` flag helps, but it walks only the *static* import graph — so a test wired to your code through a registry, dependency-injection container, or dynamic import is silently missed. A missed test is the worst failure a selector can have: the agent gets a green run and ships the break.

test-server-mcp changes what an agent's inner loop feels like. One daemon runs on your machine and holds a per-project map of which tests actually execute which source files — built from *runtime* coverage, so registry/DI edges show up because the code really ran. When a file changes, the agent gets back just the affected tests, in seconds. When the map is unsure — a brand-new file, a module only reached through global setup, a test too heavy to measure — the daemon runs the full suite rather than risk a miss. Each project runs under its *own* installed Vitest, and all of a project's state lives in a visible, git-ignored `.test-mcp/` folder in the repo — not a hidden database.

> "The bar isn't 'run fewer tests.' It's 'let an agent trust a green check after every edit.' The moment intelligent selection misses one real failure, the agent stops trusting it and goes back to running everything. So we optimize for never missing — and make speed the reward for the cases we can prove."
> — Project maintainer

### How It Works

1. `npm i -g test-server-mcp` (or add it as a dev dependency). One daemon serves every project on the machine.
2. From a repo with a Vitest config, run `test-mcp register`. It creates `.test-mcp/` (adding it to `.gitignore`), boots the shared daemon if it isn't already running, and registers the project.
3. Point your agent at the daemon. The agent calls `run_tests` (optionally `dryRun` first to see the plan), `get_test_status`, and `get_failure_details` — scoped by `projectId`. It never shells out to `vitest`.
4. The first full run builds the coverage reverse-map; from then on, edits trigger affected-only runs, and the map improves as it goes.

> "I have three agents working different features in the same monorepo. Before, they'd each kick off the full suite and my laptop fans sounded like a jet. Now each edit comes back in a few seconds and I can actually see, in the repo, why it picked those tests."
> — Developer using AI coding agents

### Getting Started

Open source under a permissive license. Install the CLI, run `test-mcp register` in any Vitest project, and connect your MCP-capable agent. macOS first; Linux/Windows follow.

---

## Customer FAQ

### Q: How is this different from `testpick`, `vitest-affected`, `vitest-agent`, `vitest-mcp`, or a future native `vitest --stale`? This space is suddenly crowded.
A: Honestly — the *core selection idea is no longer unique*, and you should know that before adopting. `testpick` already does single-pass, sharded, V8 precise-coverage delta attribution with an `explain` command and a deliberate "err toward running more" bias — essentially our coverage engine. `vitest-agent` already ships a Vitest plugin + MCP server + SQLite persistence + failure history. `vitest-affected` does ~5ms runtime reverse-map selection aimed at parallel agents. So our defensible wedge is *not* "coverage-based selection." It is: (1) **one always-on daemon serving many projects** over Streamable HTTP, rather than a per-call stdio wrapper or a per-project plugin; (2) **project-local execution** — each project runs under its own installed Vitest version in an isolated worker, so a monorepo or a machine with mismatched versions doesn't break; (3) **transparent, repo-local state** you can read and diff in `.test-mcp/`, not a hidden SQLite file; and (4) **setup-file baseline subtraction** as a first-class correctness feature, because in real suites a global `setup.ts` otherwise makes every source look like it triggers the whole suite. If those four don't matter to you, `testpick` or `vitest-agent` today are the pragmatic choice.

### Q: Will it ever skip a test that my change actually broke?
A: The whole design is built to avoid that, and we're explicit about the trade: we prioritize recall over precision. On any uncertainty — a file the map has never seen, a module only reached via global setup, or a test we couldn't measure (timeout/crash) — we run the full suite. You lose some speed in those cases; you don't lose the failure. We validated this on a real app (`spike/coverage-map/FINDINGS.md`): the design holds, but the honest caveat is that a coverage map can't see a branch a recorded run never executed — which is why the static `--changed` graph is unioned in as a second signal.

### Q: Why do I need a daemon at all? A plugin or a stdio MCP wrapper is simpler to install.
A: For a single project, a plugin *is* simpler and you should probably use one. The daemon earns its keep when you have several projects and/or several agents at once: the coverage map and history stay warm in memory, one process coordinates runs instead of N cold starts, and version isolation is enforced per project. If you only ever touch one repo, that's overhead you may not want.

### Q: Will local incremental results disagree with my CI's full run?
A: They can, and that's expected — incremental selection is an inner-loop accelerator, not a replacement for a full CI run. The daemon always supports a full run, and we recommend CI keep running everything. The map is for the edit-test-edit loop, not for the merge gate.

### Q: What about my heavy tests (e.g. big AG-Grid or integration suites) that time out or crash under coverage?
A: They're recorded as "unmeasurable" and always run on any relevant change — never silently dropped. This is deliberate: the tests most likely to be slow are often the ones most expensive to miss.

### Q: Does it work outside Vitest — Jest, pytest?
A: Not at launch. Vitest only. The architecture leaves an adapter seam, but Jest/pytest are explicitly out of scope for now. If you're a Jest shop, `testpick` already supports Jest today and is a better fit.

### Q: It's open source — will it still be maintained next year, especially if Vitest ships `--stale` natively?
A: Fair concern. A native `vitest --stale` is proposed and, if it lands, covers the simple single-project case well — which would make a plugin redundant but not necessarily a multi-project daemon with version isolation and an MCP surface. We'll say plainly: if the only value left after `--stale` ships is "coverage instead of mtime," that's a thin reason to exist, and we'd rather fold effort into the ecosystem than maintain a redundant tool.

---

## Internal FAQ

### Q: What's the hardest technical problem?
A: Building the coverage reverse-map correctly and cheaply. The spike confirmed it's feasible single-pass with setup-baseline subtraction, but it's the core build risk: per-file naive measurement was ~6× slower, and real suites need baseline subtraction or selection collapses to "run everything." The good news is the approach is now *proven in the wild* — `testpick` ships the same single-pass V8-delta technique — which de-risks feasibility but simultaneously removes it as a differentiator.

### Q: What's the competitive moat, and how durable is it?
A: Thin, and we should not pretend otherwise. As of mid-2026 the market already contains: `testpick` (coverage selection, Jest+Vitest, single-pass, explainable), `vitest-agent` (plugin+MCP+SQLite+history), `vitest-affected` (runtime reverse-map, agent-targeted), `djankies/vitest-mcp` and `@madrus/vitest-mcp-server` (AI-optimized MCP runners), and a proposed native `--stale`. Our only durable, non-obvious calls are the **multi-project always-on daemon with per-project version isolation** and **transparent repo-local state**. That's a real architectural difference, but it's a feature wedge, not a moat — any of the above could add a daemon mode.

### Q: Should we build this, or adopt/extend what exists?
A: This was *the* strategic question, and it's now **resolved (2026-07-10)**. `testpick` is MIT but a CLI that *owns the run* (shards files, spawns the runner) with no importable API — wrapping it would mean shelling out to another CLI and nesting two orchestrators on a v0.1 single-author dependency, the exact pattern we're replacing. So the decision is a middle path: **port/vendor testpick's MIT V8 snapshot-diff attribution algorithm into our own worker** — not wrap the CLI, not reinvent the algorithm — keeping our daemon/worker/state architecture, adding setup-baseline subtraction ourselves, and retaining testpick's MIT license notice. Epics 1/2/4 (daemon, project-local execution, agent workflow) remain the original contribution.

### Q: Why us, why now?
A: "Now" is real: agents running tests continuously is a 2026 workflow, and the ecosystem is actively forming (multiple tools, a native Vitest proposal). "Why us" is weaker than it was when the PRD was written — the gap we assumed was open has partially closed. Our credible claim is the daemon+isolation architecture and the correctness discipline (baseline subtraction, recall-first), not "first to coverage-based selection."

### Q: What does it cost to build, and what do we say no to?
A: Phase 1 is 4 epics / 18 stories. If we adopt an existing coverage engine, Epic 3 shrinks from "build the differentiator" to "integrate + add baseline subtraction + fallback policy," cutting the riskiest work materially. We say no to Jest/pytest, the human UI (Phase 2), priority scoring, and the research-grade features (fixture-time tracking, ordering-dependency detection, resource-contention quotas) — correctly deferred.

### Q: What kills this?
A: (1) Native `vitest --stale` lands and is "good enough" for the single-project majority. (2) `vitest-agent`/`testpick` add a daemon or multi-project mode before we ship, erasing the wedge. (3) The coverage map produces one high-profile missed failure early and burns trust. Mitigations: ship the daemon wedge fast, integrate rather than rebuild the engine, and keep the recall-first full-suite fallback loud and default.

### Q: What's the worst case if we ship and it doesn't land?
A: Low blast radius — it's open source, no user data, no infra to run. The real cost is opportunity: months spent re-implementing a solved selection core instead of on the genuinely novel daemon/isolation layer.

---

## The Verdict

**Concept strength: Needs more heat — with one crack in the foundation that the updated docs made visible.**

**Forged in steel:**
- The *problem* is real and current: AI agents running full suites per edit is a felt 2026 pain, corroborated by multiple independent tools racing at it and a native Vitest proposal aimed squarely at "agentic coding systems."
- The *correctness discipline* — recall-first, full-suite fallback on uncertainty, always-run for unmeasurable tests, setup-baseline subtraction — is sharp, defensible, and better-articulated than most competitors state theirs.
- The *daemon + project-local execution + transparent repo-local state* architecture is a genuine, non-obvious differentiator versus plugins and stdio wrappers.

**Needs more heat:**
- Positioning. The docs still imply "coverage-based selection is the differentiator." It isn't anymore. The story must pivot to "one always-on, multi-project, version-isolated test server for agents, with correctness you can inspect."
- Build-vs-adopt for the coverage engine is unresolved and should be decided before Epic 3 starts.

**Cracks in the foundation:**
- **The moat is thin and partially already occupied.** `testpick` ships our single-pass V8-coverage engine; `vitest-agent` ships our MCP+persistence surface; a native `--stale` threatens the simple case. *Resolution (2026-07-10):* differentiation reframed around the daemon/isolation/transparency wedge (docs + SPEC + spine updated); coverage engine sourced by **vendoring testpick's MIT attribution algorithm** into our worker rather than rebuilding or CLI-wrapping.

**Bottom line:** The architecture is worth building; the *novelty claim* is not what it was. Resolved by reframing around the daemon wedge and vendoring the MIT selection algorithm — not a "kill it" moment. Remaining exposure: ship the wedge before a competitor adds a daemon mode, and keep the recall-first fallback loud and default.
