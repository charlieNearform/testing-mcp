# Story 6.2: On-Disk Run-History Persistence

**ID:** `6-2`
**Slice:** `src/orchestrator` (+ optional `src/history`), `src/daemon`
**Type:** `feature`
**Depends on:** `6-1` (persists the per-test detail 6.1 adds to the run record)
**Status:** done

## Source

Run history is currently an in-memory ring buffer in the orchestrator (last ~50/project) that
**resets on daemon restart** (Story 6.0). Persist it so past runs survive restarts. The
architecture doc already envisions this location:

- `docs/architecture.md` §Data Model — "Run history … `<git-root>/.test-mcp/history/*.json`".
- Related story: `story-6-0-post-v1-onboarding-hardening.md` (in-memory store to extend).

## Acceptance criteria

1. **Given** a run completes
   **When** it is recorded
   **Then** a schema-versioned per-run record is written to
   `<git-root>/.test-mcp/history/<runId>.json` (in addition to the in-memory buffer), using an
   atomic write (temp file + rename).

2. **Given** the daemon (re)starts with registered projects
   **When** the UI/history endpoints are queried
   **Then** history is rehydrated from disk (most-recent-first, capped to the same limit) so
   past runs appear after a restart.

3. **Given** history grows past the retention cap
   **When** a new run is recorded
   **Then** the oldest on-disk records are pruned so the `history/` directory stays bounded.

4. **Given** a corrupt or unreadable history file
   **When** history is loaded
   **Then** that file is skipped (logged to stderr), never crashing the daemon — consistent
   with the "never crash the daemon / correctness over cleverness" invariants.

## Out of scope

- Cross-project aggregation, flake/trend analytics, a "clear history" UI action.
- Changing the `RunRecord` shape beyond what 6.1 already added.
- Migrating history across schema versions (single `schemaVersion: 1` for now; refuse newer).

## Notes for the agent

- **Location & ignore**: `<project.path>/.test-mcp/history/`. `.test-mcp/` is already added to
  the project `.gitignore` by `register`/`init`, so records are git-ignored — verify, don't
  re-add.
- **Atomic write**: mirror the existing pattern in `src/coverage/index.ts` `saveCoverageMap`
  (write `${target}.<pid>.tmp` then `fs.renameSync`) and `registry.save`.
- **Schema**: wrap each record as `{ schemaVersion: 1, ...RunRecord }`. Add a
  `HISTORY_SCHEMA_VERSION` const; on load, skip files with a missing/newer version.
- **Orchestrator hook**: `recordRun(record)` is the single choke point for new runs — persist
  there (it currently only pushes to the in-memory `history` map). `recordRun` today has only
  `projectId`; you'll need the project **path** to locate the dir — thread it through (add
  `path` to the call sites, which have `project` in scope, or keep a `projectId → path` map).
- **Rehydration**: add e.g. `orchestrator.loadHistory(projectId, projectPath)` that reads the
  newest-N files (sort by `finishedAt`, cap at `maxHistory`) into the in-memory buffer; call it
  for each registered project during `startDaemon` after the registry loads
  (`src/daemon/index.ts`). `getRunHistory`/`getRun` keep serving from memory (now warm from disk).
- **Pruning**: after writing a new record, delete on-disk files beyond the cap (oldest by
  `finishedAt`/mtime). Keep the in-memory cap and on-disk cap the same constant.
- Tests must be hermetic (temp git-root / `TEST_MCP_HOME`); assert: record written to disk;
  restart (new Orchestrator + `loadHistory`) surfaces prior runs; prune keeps the dir bounded;
  a corrupt file is skipped.

## Escalation triggers

- If threading the project path into `recordRun` turns out to touch more than the run paths
  (e.g. the empty-run path in `enqueue` lacks a clean `path` reference), confirm the approach
  before broadly refactoring the run pipeline.

## Auto Run Result

Status: done (dev-auto 2026-07-15)

**Change:** Run records are now mirrored to `<git-root>/.test-mcp/history/<runId>.json` (schema-versioned, atomic temp+rename) alongside the in-memory ring buffer, pruned to the same cap, and rehydrated at daemon startup so past runs survive a restart. Corrupt/newer-schema/partial files are skipped (stderr) — never crash the daemon.

**Files changed:** `src/history/index.ts` (NEW — `writeRunRecord`/`pruneHistory`/`loadHistory`, `HISTORY_SCHEMA_VERSION`), `src/orchestrator/index.ts` (`recordRun(record, projectPath)` persists + prunes; new public `loadHistory`; 3 call sites thread `project.path`), `src/daemon/index.ts` (rehydrate each registered project at startup, guarded). Tests: `test/history.test.ts` (NEW — write/load round-trip, newest-first+cap, prune-by-finishedAt keeps newest + sweeps `.tmp`, corrupt/newer/partial skip, orchestrator restart round-trip via stub worker).

**Review:** Edge Case Hunter. 5 patches applied: prune now orders by the record's own `finishedAt` (not mtime) with a stable tiebreak so the just-written run is never pruned on same-ms ties AND prune/load orderings agree; leftover `.tmp` files are swept; `loadHistory` requires a non-empty `finishedAt`; the daemon rehydration loop is wrapped so it can't abort startup; `writeRunRecord` `basename`s the runId defensively. 1 low deferred (synchronous rehydration I/O runs before the port binds — bounded in practice because prune keeps each dir ≤ cap; only a pathological pre-existing dir on first startup is slow). → deferred-work.

**Verification:** `pnpm run typecheck` exit 0; `pnpm build` exit 0; `pnpm test` exit 0 (39 files, 184 tests). Note: `test/watch.test.ts` intermittently times out under full-suite parallel load (pre-existing worker-starvation flake; passes in isolation and on a clean run).
