# test-server-mcp

MCP (Model Context Protocol) daemon for intelligent **Vitest** orchestration.

A single background daemon exposes an MCP server over loopback HTTP. AI agents (or CI) call
its tools to run a project's Vitest suite intelligently — running only the tests affected by
changed files (git delta ∪ coverage map) and falling back to the full suite whenever
selection is uncertain. Each project runs under its **own** Vitest in a dedicated worker
subprocess; the daemon never imports a project's Vitest itself.

## Features

- **Incremental selection** — run only tests affected by changed files, with a conservative
  full-suite fallback (never silently skips).
- **Coverage-aware** — builds a source→test reverse map from runtime V8 coverage.
- **Watch mode** — re-run affected tests as files change.
- **Minimal output** — failures first; full stacks fetched on demand.
- **Human monitoring UI** — a live status page at `/ui`.

## Quick start

```bash
pnpm install                 # install dependencies (pnpm only — never npm/yarn)
pnpm build                   # compile TypeScript to dist/
node ./bin/test-mcp.mjs link # put `test-mcp` on your PATH (optional, see below)

# From inside the project you want to orchestrate:
cd /path/to/your/project
test-mcp register
```

`register` scaffolds `<git-root>/.test-mcp/`, auto-boots the daemon, and registers the
project — printing the `projectId` that MCP tool calls use. Then point an MCP client at
`http://127.0.0.1:7420/mcp` and call `run_tests`.

Each `/mcp` request needs a bearer token. It's **stable across restarts** — generated once
and stored in `~/.test-mcp/config.json` (also mirrored in `daemon.lock`), so you can put it
in a client config and it won't change. Pin your own with the `TEST_MCP_TOKEN` env var:

```jsonc
// MCP client config
{
  "url": "http://127.0.0.1:7420/mcp",
  "headers": { "Authorization": "Bearer <token from config.json, or your TEST_MCP_TOKEN>" }
}
```

**→ Full guide: [docs/usage.md](docs/usage.md)** — CLI commands, the MCP tool catalog,
watch mode, the monitoring UI, CI usage, configuration, and troubleshooting.

## CLI

```bash
test-mcp start      # start the singleton daemon (idempotent)
test-mcp status     # running/stopped, pid, port, registered-project count
test-mcp stop       # graceful shutdown
test-mcp init       # scaffold <git-root>/.test-mcp/ without touching the daemon
test-mcp register   # scaffold + auto-boot daemon + register the current project
test-mcp link       # symlink this CLI into a writable dir on your PATH
test-mcp unlink     # remove that symlink
```

### Getting `test-mcp` on your PATH

`test-mcp link` symlinks the CLI into a writable directory already on your PATH
(auto-detected — e.g. `/opt/homebrew/bin` — or pass `--dir <dir>`), so you can call
`test-mcp` from anywhere. `test-mcp unlink` removes it (it only ever deletes its own
symlink, never a real file). Until you link it, invoke the CLI as `node ./bin/test-mcp.mjs`.

Alternatively, use your package manager's linker: `pnpm link --global` (after a one-time
`pnpm setup`) or `npm link` — both rely on the package's `bin` field.

## Documentation

- [Usage](docs/usage.md) — how to build, run, and use it
- [Architecture](docs/architecture.md) — components, contracts, invariants
- [PRD](docs/prd.md) — product requirements
- [Patterns](docs/patterns.md) — validated implementation patterns

## Development

```bash
pnpm typecheck      # tsc --noEmit
pnpm build          # compile to dist/
pnpm test           # vitest run (pretest builds first)
pnpm test:watch     # vitest in watch mode
```
