# Deferred Work

## Deferred from: code review of story-1-0-greenfield-project-scaffold (2026-07-13)

- Non-async stubs typed `Promise<...>` throw synchronously (`src/daemon/index.ts:1,5,9`; `src/mcp/server.ts:3`; `src/worker/index.ts:1`) — a caller using `.catch()` gets a synchronous throw before a promise exists. Stubs are replaced in Story 1.1/1.2, so make them `async` when implemented.
- Zod schema hardening (`src/types/contracts.ts:26-52`) — count fields accept NaN/negative/non-integer, no invariant that `total = passed + failed + skipped`, and `expiresAt` accepts any string (not `.datetime()`). Real schemas land in Story 1.2.
- bin `await import()` has no try/catch (`bin/test-mcp.mjs:8`) — surfaces a raw `ERR_MODULE_NOT_FOUND` instead of a "run `npm run build` first" message when `dist/` is absent.
- No `files` whitelist / `.npmignore` in `package.json` — `npm publish` would ship `src/`, `test/`, and config. Publish hygiene, out of scope for Story 1.0.
- No coverage provider/thresholds in `vitest.config.ts` — coverage is out of scope for Story 1.0 but the tool has no coverage gate on itself.
- CLI with no subcommand prints nothing and exits 0 (`src/cli/main.ts:45`) — no default `--help` fallback.
