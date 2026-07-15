# Usage

How to build, run, and use **test-server-mcp** — the MCP daemon for intelligent Vitest
orchestration. For the design behind it, see [architecture.md](architecture.md); for the
product rationale, [prd.md](prd.md).

## What it is

A single background **daemon** exposes an MCP server over loopback HTTP. AI agents (or CI)
call its tools to run a project's Vitest suite intelligently — running only the tests
affected by changed files (git delta ∪ coverage map), falling back to the full suite
whenever selection is uncertain. Each registered project runs under **its own** Vitest in a
dedicated worker subprocess; the daemon never imports a project's Vitest itself.

```
AI agent / CI ──MCP over HTTP──▶ daemon (one per machine) ──fork──▶ worker (per project)
test-mcp CLI  ──starts/registers─▶                                   └ runs project's Vitest
```

## Prerequisites

- **Node 20+** and **pnpm** (this repo is pnpm-only — never `npm`/`yarn`).
- **git** on `PATH` — projects are keyed by their git root.
- Each project you register must have a resolvable **Vitest/Vite config** at its root.

## Install & build

```bash
pnpm install        # install dependencies
pnpm build          # compile TypeScript to dist/ (required — the CLI runs from dist/)
```

The CLI entrypoint is `bin/test-mcp.mjs`, which loads `dist/cli/main.js`. If you see
`dist/cli/main.js not found`, you haven't built yet. During development, `pnpm dev` runs
`tsc --watch`.

To invoke the CLI, use the built binary directly:

```bash
node ./bin/test-mcp.mjs <command>
```

The examples below write it as `test-mcp <command>` for brevity. To get `test-mcp` on your
`PATH`, run:

```bash
node ./bin/test-mcp.mjs link       # symlink into a writable PATH dir (auto-detected)
node ./bin/test-mcp.mjs link --dir ~/bin   # ...or a directory you choose
```

`link` picks a writable directory already on your `PATH` (preferring `/opt/homebrew/bin`,
`/usr/local/bin`, then `~/.local/bin`) and symlinks the CLI there; `unlink` removes it
(it only deletes its own symlink, never a real file). Alternatively use your package
manager's linker — `pnpm link --global` (after `pnpm setup`) or `npm link`.

## The daemon

One daemon serves every project on the machine (invariant: **one daemon per system**,
enforced by a lockfile + known port in the central directory).

```bash
test-mcp start      # start the singleton daemon (idempotent — no-op if already running)
test-mcp status     # report running/stopped, pid, port, and registered-project count
test-mcp stop       # graceful shutdown
```

- Binds **`127.0.0.1` only**, default port **7420**.
- On start it writes `~/.test-mcp/daemon.lock` (`0600`) with `{ pid, port, token, startedAt }`.
  The `token` is a bearer secret; every `/mcp` request must carry `Authorization: Bearer
  <token>`. It is **stable across restarts** — generated once and persisted in
  `~/.test-mcp/config.json`, so you can configure an MCP client with it and it won't change.
  Override it with the `TEST_MCP_TOKEN` env var.
- You usually don't run `start` by hand — `test-mcp register` auto-boots the daemon
  (detached) if it isn't already up.

## Register a project

Run this from inside the project you want to orchestrate (any directory within its git
tree):

```bash
cd /path/to/your/project
test-mcp register
```

This:
1. Resolves the git root.
2. Creates `<git-root>/.test-mcp/config.json` (with a stable `projectId`) if absent.
3. Adds `.test-mcp/` to the project's `.gitignore`.
4. Auto-boots the daemon if needed, then calls the `register_project` MCP tool.

On success it prints the `projectId` — that's what every project-scoped tool call needs.

`test-mcp init` performs only steps 1–3 (scaffold the local `.test-mcp/` without touching
the daemon) — useful for committing the `.gitignore` change before a daemon is available.

### CI usage

In CI you generally want an explicit, ephemeral daemon per job rather than a persistent one:

```bash
test-mcp start &                 # boot a daemon for this job
test-mcp register --no-spawn     # fail (don't auto-boot) if the daemon isn't up
# ... run tests via an MCP client ...
test-mcp stop
```

`--no-spawn` makes `register` error out instead of starting a daemon, so a
misconfigured job fails loudly.

## Calling the MCP tools

The daemon speaks MCP over **Streamable HTTP** at `http://127.0.0.1:<port>/mcp`. Point any
MCP client at that URL and send the bearer token from the lockfile.

```jsonc
// Example MCP client config (URL + auth header).
// The token is stable across restarts — read it once from ~/.test-mcp/config.json
// (or daemon.lock), or pin your own via the TEST_MCP_TOKEN env var.
{
  "url": "http://127.0.0.1:7420/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

Pin a known token so the client config never needs updating:

```bash
export TEST_MCP_TOKEN=my-stable-secret
test-mcp start
```

The CLI itself is a reference client: `test-mcp register` reads the lockfile, connects over
HTTP with the bearer header, and calls `register_project`.

### Tool catalog

All errors come back as the structured envelope `{ code, message, details? }` (never a
daemon crash). Codes: `UnknownProject`, `InvalidConfig`, `WorkerFailure`, `PlanExpired`,
`ValidationError`, `DaemonUnavailable`.

| Tool | Input | Returns |
|------|-------|---------|
| `register_project` | `{ path }` (absolute project root) | `{ projectId, path, status }` |
| `list_projects` | `{}` | `{ projects: [...] }` |
| `unregister_project` | `{ projectId, purge? }` | `{ projectId, removed }` — `purge` also deletes the project's `.test-mcp/` state |
| `run_tests` | `{ projectId, mode?, coverage?, files?, suite?, dryRun?, planId? }` | `TestResult`, or a `TestPlan` when `dryRun` |
| `get_test_status` | `{ projectId }` | `{ state, latest?, watch? }` |
| `start_watch` | `{ projectId, fastMode? }` | watch status |
| `stop_watch` | `{ projectId }` | `{ stopped }` |
| `get_failure_details` | `{ projectId, failureId }` | `{ name, file, message, stack, assertion? }` |

### Running tests

```jsonc
// Incremental (default intent): run only tests affected by changed files.
{ "projectId": "…", "mode": "incremental" }

// Full suite.
{ "projectId": "…", "mode": "full" }

// Refresh the source→test coverage map on this run (needed for incremental to work well).
{ "projectId": "…", "mode": "full", "coverage": true }

// Specific files.
{ "projectId": "…", "files": ["test/foo.test.ts"] }
```

**Selection is conservative.** If a changed file is unknown to the coverage map, is a
setup-baseline module (e.g. a shared `i18n.ts`), or belongs to a test that couldn't be
measured, the daemon runs the **full suite** rather than risk skipping a relevant test.
Build/refresh the coverage map (`coverage: true`) to get the incremental speedup.

`run_tests` streams per-file progress as MCP `notifications/progress` when the client
supplies a `progressToken`. The final response is the authoritative `TestResult`.

`failures[]` in a `TestResult` carries only `{ id, name, file, message }`; fetch the stack
and assertion diff on demand with `get_failure_details({ projectId, failureId })`.

### Dry-run → commit

Inspect a selection before running it:

```jsonc
{ "projectId": "…", "dryRun": true }          // → TestPlan { planId, files, reasoning, expiresAt }
{ "projectId": "…", "planId": "<planId>" }    // execute exactly that plan
```

Plans are cached briefly; an expired `planId` returns `PlanExpired` — re-run the dry-run.

### Watch mode

```jsonc
{ "projectId": "…" }                    // start_watch — re-runs affected tests as files change
{ "projectId": "…", "fastMode": false } // also refresh the coverage map (slower)
```

`fastMode` defaults to `true` (skips coverage for speed). Poll `get_test_status` for the
latest watch result; call `stop_watch` to end it.

## Monitoring UI (for humans)

While the daemon is running, open a browser at:

```
http://127.0.0.1:7420/ui
```

- `GET /ui` — live status page (no bearer required; loopback-gated, GET-only).
- `GET /ui/api/status` — JSON snapshot.
- `GET /ui/events` — Server-Sent Events stream of live updates.

`GET /health` (or `/`) returns `{ status: "ok", daemon: "test-mcp" }` — a quick liveness
check that also needs no auth.

## State & configuration

| What | Location | Notes |
|------|----------|-------|
| Daemon config | `~/.test-mcp/config.json` | `port` (7420), `maxConcurrentWorkers` (CPU count), `workerIdleTtlMs` (300000), `token` (stable bearer secret); mode `0600` |
| Lockfile | `~/.test-mcp/daemon.lock` | `{ pid, port, token, startedAt }`, mode `0600` |
| Project registry | `~/.test-mcp/registry.json` | central record of registered projects |
| Per-project config | `<git-root>/.test-mcp/config.json` | `projectId`, `stateDir`; git-ignored |
| Coverage map | `<git-root>/.test-mcp/coverage-map.json` | source→test reverse map |
| Run history | `<git-root>/.test-mcp/history/*.json` | per-run records |

Environment overrides:

- **`TEST_MCP_HOME`** — override the central directory (default `~/.test-mcp`). Use it to
  isolate a daemon; tests and CI jobs set it to a temp dir so they never touch a real
  `~/.test-mcp/`.
- **`TEST_MCP_TOKEN`** — override the `/mcp` bearer token. When set it takes precedence over
  the persisted `config.token` and is not written to disk. Handy for pinning a known token
  in CI or a client config.

The central directory (daemon-global) and per-project `.test-mcp/` are strictly separate:
project state is never written centrally, and vice versa.

## Troubleshooting

- **`dist/cli/main.js not found`** — run `pnpm build` first.
- **`DaemonUnavailable: daemon not running and --no-spawn set`** — drop `--no-spawn`, or
  `test-mcp start` first.
- **`not a git repository`** — `register`/`init` must run inside a git working tree.
- **`UnknownProject`** — the `projectId` isn't registered; run `test-mcp register` in that
  project (or check `list_projects`).
- **`InvalidConfig`** — the project has no resolvable Vitest/Vite config at its root.
- **`401 Missing or invalid bearer token`** — your client's `Authorization` header doesn't
  match the daemon token. The token is stable across restarts; re-read it from
  `~/.test-mcp/config.json` (or `daemon.lock`), or pin one via `TEST_MCP_TOKEN`.
- **Stale daemon after a crash** — `test-mcp status`; if it reports stopped but a lockfile
  lingers, `test-mcp start` reclaims it.

## Development

```bash
pnpm typecheck      # tsc --noEmit
pnpm build          # compile to dist/
pnpm test           # vitest run (pretest builds first)
pnpm test:watch     # vitest in watch mode
```
