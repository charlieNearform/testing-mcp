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

### Added

- `docs/usage.md`: a how-to-run guide covering the daemon lifecycle, project registration,
  the MCP tool catalog, watch mode, the monitoring UI, CI usage, configuration, and
  troubleshooting.
- `test-mcp link` / `test-mcp unlink` CLI commands: symlink the CLI into a writable
  directory on `PATH` (auto-detected or via `--dir`) so it can be run as `test-mcp` from a
  cloned checkout; `unlink` only ever removes its own symlink, never a real file.
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
