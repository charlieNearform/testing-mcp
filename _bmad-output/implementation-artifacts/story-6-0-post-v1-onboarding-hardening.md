# Story 6.0: Post-v1 Onboarding & Hardening (as-built)

Status: done

> **Retrospective record.** This work was implemented directly on `main` on 2026-07-15
> outside the BMAD story cycle. It is captured here so the plan reflects reality; the
> acceptance criteria below were verified as the work shipped (see commit range
> `572994a..18ad562`). Future work (6.1+) resumes the normal story → dev → review flow.

## Acceptance Criteria

1. Usage guide (`docs/usage.md`) and a corrected README exist; CLI offers `mcp-config`, `ui`,
   `link`, `unlink` alongside `init`/`register`/`start`/`stop`/`status`. ✅
2. `/mcp` bearer token is stable across restarts and configurable (persisted `config.token`,
   `TEST_MCP_TOKEN` override, `0600`); `mcp-config` emits two token-safe options (local-scope
   command; committed `.mcp.json` with a `headersHelper` reading `~/.test-mcp/token`). ✅
3. Adversarial code-review findings remediated with tests (see below). ✅
4. `/ui` live-updates over SSE and supports drill-down (project → run history → run detail),
   backed by an in-memory run-history store. ✅

## What shipped

**Docs & packaging**
- `docs/usage.md` (new) — daemon lifecycle, registration, tool catalog, watch mode, monitoring
  UI, CI, config, troubleshooting. README rewritten to match the shipped CLI. `docs/architecture.md`
  reconciled with the implementation (coverage-map shape, error codes, tool/command lists, IPC
  snippet, worker-pool/history "planned vs built" notes). `package.json` marked `private: true`.

**Onboarding / CLI** (`src/cli/main.ts`, `src/daemon/index.ts`, `bin/test-mcp.mjs`)
- **Stable configurable token**: `resolveToken` = `TEST_MCP_TOKEN` → persisted `config.token` →
  generate-once-and-persist; `config.json` written `0600`; live token mirrored in `daemon.lock`.
- **`link`/`unlink`**: symlink the CLI into a writable PATH dir (auto-detected or `--dir`);
  `--force` overwrites only a symlink, never a real file.
- **`mcp-config`**: prints local-scope `claude mcp add` and a committed-safe `.mcp.json`
  `headersHelper`; daemon writes a plaintext `~/.test-mcp/token` (`0600`) for the helper.
- **`ui`**: prints the monitoring UI URL; `register` prints the UI link + points to `mcp-config`.
- Flush stdout/stderr before `process.exit` so piped CLI output isn't truncated.

**Hardening (code-review remediation)**
- Coverage watch self-loop fixed (`isIgnoredWatchPath` ignores `__test-mcp-*`).
- Atomic `registry.json` write (temp + rename).
- Zod validation at boundaries: `config.json`, `registry.json` entries, and fork() IPC
  (`parseToWorker`/`parseFromWorker`).
- Global worker concurrency cap (`maxConcurrentWorkers`, previously inert).
- Plan-cache eviction; malformed coverage-map safe-defaulting; zero-test run = success;
  daemon no longer self-closes on a transient socket error; IPv6 loopback Host/Origin
  normalization; `catch(unknown)`.

**Observability** (`src/orchestrator/index.ts`, `src/ui/index.ts`)
- In-memory run-history ring buffer (last ~50/project) recording id, timestamps, duration,
  status, selection (strategy + files + reason), counts, and failure details.
- `/ui` reworked into a hash-routed SPA (project list → run history → run detail), live over
  the existing SSE stream. New endpoints `/ui/api/projects/:id/runs` and `…/runs/:runId`.

## Tests

Added/updated: `cli-link`, `cli-mcp-config`, `cli-ui`, `ipc-validation`, `registry-validation`,
`orchestrator-concurrency`, `orchestrator-history`, `ui-history`, `watch-ignore`, and daemon
token/config cases. Full suite green at **122/122** (typecheck + build clean) as of `18ad562`.

## Follow-ups (became Epic 6 stories)

- **6.1** — per-passing-test detail (worker only itemizes failures today).
- **6.2** — on-disk run-history persistence (history is in-memory, resets on restart).
