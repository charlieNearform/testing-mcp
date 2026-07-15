# Story 6.5: Don't Full-Suite on Test-Irrelevant File Changes

**ID:** `6-5`
**Slice:** `src/selection`
**Type:** `feature`
**Depends on:** `6-0` (independent of 6.4, but 6.4's reason reporting makes this observable)
**Status:** ready-for-dev

## Source

Investigation on 2026-07-15: sanity-check ran the full suite on every incremental run because
its working tree had unrelated changed files — `.gitignore`, `.mcp.json`, `CLAUDE.md`. The
Selection Engine treats **any** changed non-test file unknown to the coverage map as a
full-suite trigger (invariant 5, "when uncertain run more"). That's safe but too blunt: those
files cannot affect a JS/TS test run, yet they force a full suite forever.

- Related: `src/selection/index.ts` (`SelectionEngine.plan`, `getChangedFiles`),
  `docs/architecture.md` invariant 5, `docs/patterns.md`.

## Acceptance criteria

1. **Given** the only changed files are provably test-irrelevant (e.g. `.gitignore`,
   `.mcp.json`, `CLAUDE.md`, `*.md`, editor/agent dotfiles)
   **When** an incremental run is planned
   **Then** those files are excluded from selection input, so the run is **not** forced to the
   full suite on their account (if nothing test-relevant changed → treated as "no relevant
   changes").

2. **Given** a changed file that *could* affect tests (source/test files, and build/test config
   such as `package.json`, lockfiles, `*.config.{js,ts,mjs,cjs}`, `tsconfig*.json`, setup files)
   **When** selection runs
   **Then** the existing conservative behaviour is unchanged — unknown/config changes still
   trigger the full suite (invariant 5 preserved for anything that could matter).

3. **Given** a mix of ignored and relevant changes
   **When** selection runs
   **Then** only the relevant changes drive selection; ignored ones are dropped.

4. **Given** the ignore set
   **When** it is defined
   **Then** it is a conservative, documented default (and structured so it can become
   configurable later); the reason (via 6.4) makes clear what was ignored vs. what triggered.

## Out of scope

- A user-configurable ignore list / per-project config (design it to allow this later, but
  ship a sensible built-in default only).
- Changing coverage-map building or the git `--changed` fast path semantics beyond filtering
  the input file set.
- Trying to reason about data-file fixtures a test reads at runtime (not captured by coverage
  anyway) — out of scope; keep the ignore set to files that can't affect *execution*.

## Notes for the agent

- Apply the filter to the changed-file list **before** `changedTests`/`changedSources` are
  computed in `SelectionEngine.plan` (or in `getChangedFiles`), so all downstream logic sees
  only test-relevant paths.
- **Conservative default ignore set** (things that cannot affect a JS/TS test run): `*.md`,
  `LICENSE*`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.mcp.json`, `CLAUDE.md`,
  `.cursorrules`/`.cursor/**`, `.vscode/**`, `.idea/**`, `.github/**`, and anything under the
  tool's own `.test-mcp/`. **Do NOT ignore**: `package.json`, lockfiles, `*.config.*`,
  `tsconfig*.json`, `vitest.setup.*`, or any `.js/.jsx/.ts/.tsx/.mjs/.cjs` file — these can
  change test behaviour and must stay conservative (full-suite triggers when unmapped).
- If, after filtering, no relevant files remain, return the same "no changes" outcome the
  engine already produces for an empty changed set (runs nothing), not a full suite.
- `plan` is pure and unit-tested — add cases: only-irrelevant → no full suite; irrelevant+source
  → source drives it; config change → still full.

## Escalation triggers

- This narrows invariant 5 ("when uncertain, run more"). Before finalizing the ignore set,
  confirm the boundary with the architecture spine (`docs/architecture.md`) — the safe rule is
  "ignore only files that provably cannot affect execution; when unsure, keep it a trigger."
  Escalate any candidate whose test-irrelevance isn't certain.

## Ratified update (course-correction 2026-07-15)

Confirmed by `sprint-change-proposal-2026-07-15.md`:
- **Default = ignore non-code files** (docs/markdown, VCS/editor/agent dotfiles) — this is
  now default behaviour with an **opt-out** flag, not opt-in.
- **Add a project ignore file** `<git-root>/.test-mcp-ignore` (gitignore-style patterns), read
  at selection time and unioned with the built-in non-code default. Documented in
  `docs/architecture.md` §Data Model.
- The invariant-5 narrowing is ratified (see architecture invariant 5, now confidence-based).
