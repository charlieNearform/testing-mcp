# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Commit & changelog conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

- `type(scope): summary` — where **scope is the GitHub issue number** the commit relates
  to, e.g. `feat(123): implement coverage reverse-map`.
- `type: summary` — omit the scope for unscoped changes, e.g. `docs: add project plan`.
- Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`.

Changelog entries are grouped under **Added / Changed / Deprecated / Removed / Fixed /
Security**, referencing the GitHub issue (`#123`) where applicable.

## [Unreleased]

### Fixed

- **Coverage watch mode no longer self-loops.** A coverage-enabled watch run wrote+deleted a
  transient baseline test in the project root, which the watcher saw and re-triggered
  forever; the watcher now ignores `__test-mcp-*` files.
- **`test-mcp link --force` no longer deletes a real file.** `--force` now overwrites only an
  existing symlink; it refuses to clobber a regular file, matching `unlink`.
- **`registry.json` is written atomically** (temp file + rename) so an interrupted write can
  no longer truncate it and lose every registered project.
- **External input is validated with Zod at the boundary**: fork() IPC messages
  (`parseToWorker`/`parseFromWorker`), `config.json`, and `registry.json` entries — malformed
  data is rejected instead of corrupting daemon state.
- **Global worker concurrency is bounded** by `maxConcurrentWorkers` (previously loaded but
  unused), preventing an unbounded fork storm across many projects.
- Expired dry-run plans are swept from the in-memory cache; a partial/hand-edited coverage
  map can no longer throw in the selection path; a dispatched run that matches zero tests is
  reported as success (nothing failed); the live daemon no longer self-closes on a transient
  socket error; CLI output is flushed before exit so piped output isn't truncated; the
  "not found" bin hint says `pnpm build`; IPv6 loopback Host/Origin parsing is corrected.

### Added

- `docs/usage.md`: a how-to-run guide covering the daemon lifecycle, project registration,
  the MCP tool catalog, watch mode, the monitoring UI, CI usage, configuration, and
  troubleshooting.
- `test-mcp link` / `test-mcp unlink` CLI commands: symlink the CLI into a writable
  directory on `PATH` (auto-detected or via `--dir`) so it can be run as `test-mcp` from a
  cloned checkout; `unlink` only ever removes its own symlink, never a real file.
- `test-mcp mcp-config` CLI command: prints ready-to-use MCP client config to connect an
  agent to the daemon, with two token-safe options — a local-scope `claude mcp add` command
  (token stays out of the repo) and a committed-safe `.mcp.json` referencing
  `${TEST_MCP_TOKEN}`. `register` now points to it.
- `test-mcp ui` CLI command: prints the monitoring UI URL (bare, on stdout, so it can be
  piped to a browser). `register` now prints the UI link on success too.
- BMAD scaffolding and full planning artifact set under `_bmad-output/planning-artifacts/`:
  requirements contract (`SPEC.md`), architecture spine (`ARCHITECTURE-SPINE.md`),
  epics & stories (`epics.md` — 5 epics / 18 stories), PRFAQ + distillate, and an
  implementation-readiness report (status: READY).
- Source-of-truth docs: `docs/prd.md`, `docs/architecture.md`, `docs/patterns.md`.
- Coverage-mapping spike harness (`spike/coverage-map/build-map.mjs`) validating the
  single-pass V8 snapshot-diff + setup-baseline-subtraction approach against a real target
  project; findings written up in `docs/coverage-spike-findings.md`. Generated spike output
  (`spike/**/out/`) is git-ignored, not tracked.
- `THIRD_PARTY_LICENSES.md` recording testpick (MIT) attribution for the coverage
  attribution algorithm to be vendored in Epic 3.

### Changed

- The `/mcp` bearer token is now **stable across daemon restarts** instead of regenerated
  on every start: resolved as `TEST_MCP_TOKEN` env override → persisted `config.token` →
  generated once and written back to `~/.test-mcp/config.json`. This lets MCP clients be
  configured statically. `config.json` is now written mode `0600` since it holds the secret.
- Rewrote `README.md` to match the shipped CLI and daemon (the old quick-start referenced
  non-existent scripts and a missing `docs/configuration.md`).
- Marked the package `"private": true` to prevent accidental `npm publish` while it is
  clone-only; remove this to publish.

- Redesigned the product from a per-session single-project tool into a persistent
  on-system **singleton daemon** serving multiple registered projects, with per-project
  worker execution using each project's own Vitest.
- Reframed positioning: coverage-based selection is table-stakes; the differentiator is
  the daemon + project-local version isolation + transparent repo-local state +
  setup-baseline correctness.
