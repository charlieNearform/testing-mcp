# Deferred Work Ledger

## Deferred from: code review of story-1-2-mcp-server-over-streamable-http-secured.md (2026-07-14)

- Unbounded request-body buffering and session-map growth (`src/mcp/server.ts:132`) — hardening backlog for localhost-only daemon
- `ValidationError` code reused for HTTP-layer faults (403/401/404) (`src/mcp/server.ts:163`) — semantic nit; behavior is correct
- OPTIONS/CORS, HEAD health, Bearer case-insensitivity, alternate loopback literals (`src/mcp/server.ts:103`) — outside story AC; revisit if browser clients land
