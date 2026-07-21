---
title: 'pnpm build automatically refreshes a running daemon'
type: 'feature'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 0
context: []
route: 'one-shot'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Cursor disconnects from the MCP server every time the daemon needs to be restarted to pick up freshly built code, and manually reconnecting it is a recurring annoyance.

**Approach:** Add `test-mcp restart` (restarts the daemon if running, no-op otherwise, always best-effort) and wire it into `pnpm build` via a script restructure — `build:compile` (pure `tsc`) is the real compile step; `build` = compile + restart; `pretest`/`prepublishOnly` call `build:compile` directly so `pnpm test`/`pnpm publish` never trigger a daemon restart as a side effect. This relies on — and does not modify — the existing, already-tested bridge session-recovery logic (`test/cli-mcp-bridge.test.ts`) that already proves a stdio-connected MCP client survives a daemon restart transparently.

</frozen-after-approval>

## Suggested Review Order

**The new trigger**

- `restart` command: calls `stopDaemon()` unconditionally (inherits its stale-lockfile cleanup), branches on its `reason` for accurate messaging, spawns a fresh detached daemon with a guarded `child.once("error", ...)` handler (a first draft omitted this and could have crashed instead of exiting 0), all wrapped in one top-level try/catch so every path is best-effort.
  [`cli/main.ts:332`](../../src/cli/main.ts#L332)

**The script restructure this depends on**

- `build:compile` split out; `build` = compile + restart; `pretest`/`prepublishOnly` call `build:compile` directly so the test/publish paths never touch the daemon.
  [`package.json:23`](../../package.json#L23)

**Tests**

- Restart replaces a running daemon (new pid, same port, same token) — the token assertion matters because the bridge's cached `Authorization` header must still be valid against the new daemon.
  [`cli-daemon.test.ts:109`](../../test/cli-daemon.test.ts#L109)

- Stale-lockfile cleanup and the plain no-op case.
  [`cli-daemon.test.ts:73`](../../test/cli-daemon.test.ts#L73)

**Peripheral**

- Docs: the new `restart` command, and its best-effort failure modes (so a build reporting anything other than "refreshed" tells you to check `test-mcp status`).
  [`docs/usage.md:62`](../../docs/usage.md#L62)

## Verification

**Commands:**
- `pnpm run typecheck` / `pnpm run build:compile` -- expected: exit 0
- `pnpm exec vitest run test/cli-daemon.test.ts` -- expected: 6/6 pass (verified 4/4 consecutive runs)
- `pnpm test` (full suite) -- expected: all pass; verified this never disturbs a real, independently-running daemon (started one on the real default port before running the full suite, confirmed its pid was unchanged afterward)
- `pnpm run build` -- expected: refreshes a running daemon (verified live against the real daemon: pid changed, port/token/registered-projects preserved) and is a clean no-op when nothing is running

**Manual check performed:** drove a real `mcp-bridge`-connected MCP client (mirroring Cursor) through a `test-mcp restart` while the client stayed open and never reconnected — the client's very next tool call succeeded via the bridge's existing session-recovery path, confirming the end-to-end user-facing claim, not just the CLI command in isolation.
