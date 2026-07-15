# Contributing

For working **on** test-server-mcp. If you're only *using* the daemon to run a project's
tests, you don't need any of this — see [README.md](README.md) and [docs/usage.md](docs/usage.md).

## Prerequisites

- **Node 20+** and **pnpm** (never `npm`/`yarn` — see [CLAUDE.md](CLAUDE.md)).
- **git**.
- **[uv](https://docs.astral.sh/uv/)** — the repo's mandated Python toolchain (BMAD scripts run
  via `uv run`), and what the optional code-intelligence tool below uses.

## Dev workflow

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm build           # compile to dist/
pnpm test            # vitest run (pretest builds first)
```

Planning, stories, and code review go through the **BMAD** workflow (see
`_bmad-output/` and the `bmad-*` skills); implementation follows the story files under
`_bmad-output/implementation-artifacts/`.

## Optional: code-review-graph (AI code-intelligence)

This repo commits a `.mcp.json` that registers **[code-review-graph](https://code-review-graph.com/)**
(CRG) — a local, Tree-sitter dependency/"blast-radius" graph that helps AI coding tools read
only the relevant code. It is **optional dev tooling for contributors** and is **not required**
to build, test, or use test-mcp — and consumers of test-mcp never need it.

If you want it while developing here:

```bash
uv tool install code-review-graph   # or rely on uvx (the .mcp.json uses `uvx`, which fetches it)
code-review-graph build             # index this repo -> .code-review-graph/ (git-ignored)
```

Then reload your MCP client (e.g. Claude Code) and approve the `code-review-graph` server; its
tools (blast radius, impact/change detection, semantic search) become available. `serve` runs
with `--auto-watch`, so the graph stays current as you edit; otherwise run
`code-review-graph update`. The graph DB lives in the git-ignored `.code-review-graph/`.

To skip it entirely, decline/disable the server in your MCP client — nothing else depends on it.
