# Deferred Work Ledger

## Deferred from: code review of story-1-3-project-registration-via-test-mcp-register.md (2026-07-14)

- In-memory registry empty after daemon restart until Story 1.4 `load()` — intentional scope boundary; `status` reads disk so counts can disagree with MCP tools until 1.4
- Non-atomic `registry.json` write — crash mid-write can corrupt file; address with Story 1.4 persistence hardening
