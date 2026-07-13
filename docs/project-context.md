# Project Context — test-server-mcp

Persistent facts for all agents working in this repo. BMAD skills load this file
automatically (`**/project-context.md`). Read it before planning or implementing.

## Toolchain (non-negotiable)

- **Package manager: pnpm.** Never use `npm` or `yarn`.
  - Install: `pnpm install`
  - Scripts: `pnpm build`, `pnpm test`, `pnpm run typecheck`
  - Lockfile: `pnpm-lock.yaml` is committed.
  - **Workspace anchor:** a `pnpm-workspace.yaml` lives at the repo root and MUST stay.
    A `pnpm-workspace.yaml` also exists in `$HOME`; without the local anchor, pnpm walks
    up to it and installs an empty root, leaving this repo with no `node_modules`.
- **Runtime:** Node 20+ (dev machine runs newer; keep `engines.node: ">=20"`).
- **Module system:** ESM only (`"type": "module"`).
- **Language:** TypeScript, `strict: true`, compiled to `dist/` via `tsc`. NodeNext resolution.
- **Dependencies:** pinned exact versions (no `^`/`~`). Do not add deps beyond what a
  story explicitly authorizes.
- **Tests:** Vitest, in `devDependencies` only. `pretest` runs `pnpm build` first so
  `pnpm test` passes on a clean checkout.

## Architecture guardrails

- Authority docs: `docs/architecture.md`, `docs/scaffold-spec.md`, and
  `_bmad-output/planning-artifacts/epics.md`. Follow them literally.
- The scaffold directory layout is fixed. Add behaviour to existing paths; never rename
  or relocate them.
- Daemon isolation invariant: the daemon process never imports a consumer project's
  Vitest; the per-project worker resolves `vitest/node` from the project's own
  `node_modules`.
- Persisted JSON carries a `schemaVersion`. Error envelope is `{ code, message, details? }`.

## Division of labour (how work flows here)

- **Planning, story authoring, code review, sprint tracking** are done by the
  orchestrating (BMAD) agent.
- **Implementation is delegated to a local model (qwen3-coder-next)**, which needs
  maximal explicitness. When writing a story or dev task for implementation:
  - State the exact files to create/edit (full paths) and the exact expected contents
    or a copy-paste-ready contract — no "figure it out" gaps.
  - Give literal, ordered steps and the exact commands to run (`pnpm ...`).
  - Include explicit, checkable acceptance criteria and the exact verification commands
    with expected exit codes / output.
  - Call out what NOT to touch (paths, deps, unrelated files) and any invariants above.
  - Prefer unambiguous instructions over prose; assume no inference.
