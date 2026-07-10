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

- BMAD scaffolding and full planning artifact set under `_bmad-output/planning-artifacts/`:
  requirements contract (`SPEC.md`), architecture spine (`ARCHITECTURE-SPINE.md`),
  epics & stories (`epics.md` — 5 epics / 18 stories), PRFAQ + distillate, and an
  implementation-readiness report (status: READY).
- Source-of-truth docs: `docs/prd.md`, `docs/architecture.md`, `docs/patterns.md`.
- Coverage-mapping spike (`spike/coverage-map/`) validating the single-pass V8
  snapshot-diff + setup-baseline-subtraction approach against a real target project.
- `THIRD_PARTY_LICENSES.md` recording testpick (MIT) attribution for the coverage
  attribution algorithm to be vendored in Epic 3.

### Changed

- Redesigned the product from a per-session single-project tool into a persistent
  on-system **singleton daemon** serving multiple registered projects, with per-project
  worker execution using each project's own Vitest.
- Reframed positioning: coverage-based selection is table-stakes; the differentiator is
  the daemon + project-local version isolation + transparent repo-local state +
  setup-baseline correctness.
