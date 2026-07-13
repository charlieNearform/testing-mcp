# Deferred Work

## Deferred from: code review of story-1-0-greenfield-project-scaffold (2026-07-13)

- Non-async stubs typed `Promise<...>` throw synchronously (`src/daemon/index.ts:1,5,9`; `src/mcp/server.ts:3`; `src/worker/index.ts:1`) — a caller using `.catch()` gets a synchronous throw before a promise exists. Stubs are replaced in Story 1.1/1.2, so make them `async` when implemented.
- Zod schema hardening (`src/types/contracts.ts:26-52`) — count fields accept NaN/negative/non-integer, no invariant that `total = passed + failed + skipped`, and `expiresAt` accepts any string (not `.datetime()`). Real schemas land in Story 1.2.
- bin `await import()` has no try/catch (`bin/test-mcp.mjs:8`) — surfaces a raw `ERR_MODULE_NOT_FOUND` instead of a "run `pnpm build` first" message when `dist/` is absent.
- No `files` whitelist in `package.json` — `pnpm publish` would ship `src/`, `test/`, and config. RESOLVED post-review: `files: ["dist/","bin/"]` added.
- No coverage provider/thresholds in `vitest.config.ts` — coverage is out of scope for Story 1.0 but the tool has no coverage gate on itself.
- CLI with no subcommand prints nothing and exits 0 (`src/cli/main.ts:45`) — no default `--help` fallback. RESOLVED in Story 1.1 (default-help block added).

## Deferred from: code review of story-1-1-singleton-daemon-lifecycle-cli (2026-07-13)

Daemon lifecycle hardening — safe to defer because the Story 1.1 daemon is a foreground, single-user local process; these paths are rare now but should be closed before/with Story 1.3 (auto-boot) and Story 1.2 (schema hardening):

- **Atomic/exclusive lockfile create** (`src/daemon/index.ts` `startDaemon`) — `readLockfile → isPidAlive → writeFileSync` is a TOCTOU; two concurrent `start`s can both proceed. Use an `wx`/`O_EXCL` exclusive create so only one wins. (Currently also guarded by the port bind + CLI error handling.)
- **PID + token validation before signalling** (`stopDaemon`, `startDaemon` already-running path) — liveness alone can mis-target a recycled PID. Verify the live process is our daemon (e.g. round-trip the lockfile `token` via the HTTP server, or compare `startedAt`) before `SIGTERM`/"already running".
- **Boundary validation of config/lockfile** — Zod-validate on load: `port` finite/≥0, required fields present; a partial lockfile (`{pid}` only) currently yields undefined `port`/`token`. (Aligns with the Story 1.2 schema-hardening work.)
- **Atomic writes** for `config.json` and `daemon.lock` (temp file + `rename`) so a crash mid-write can't leave truncated JSON.
- **SIGKILL escalation** in `stopDaemon` after the SIGTERM timeout (currently returns `stopped:false, reason:"timeout"` and leaves the process).
