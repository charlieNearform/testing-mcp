# CLAUDE.md

Agent operating instructions for the **test-server-mcp** repo. Read this first, every session.
Deeper project facts live in `docs/project-context.md` — load it too.

## Language (non-negotiable)

- **All output is in English.** This includes session/chat titles, commit messages, code
  comments, PR text, and any file you write. Never emit Chinese (or any non-English) text,
  even for a title or summary. If asked to title a session, the title MUST be English.

## Python (non-negotiable)

- **Run every Python script through `uv`.** Use `uv run python path/to/script.py`, never
  bare `python path/to/script.py` or `python3 ...`.
- This applies to BMAD scripts (e.g. `_bmad/scripts/resolve_customization.py`) and any
  other Python in this repo.

## Package manager (non-negotiable)

- **pnpm only.** Never `npm` or `yarn`.
  - `pnpm install`, `pnpm run typecheck`, `pnpm run build`, `pnpm test`.
  - `pnpm-lock.yaml` and the root `pnpm-workspace.yaml` are committed and required — do not
    delete the workspace anchor (a `pnpm-workspace.yaml` in `$HOME` will hijack installs
    without it).

## BMAD development process (non-negotiable)

- **All feature/story-sized work goes through the BMAD story cycle** —
  `bmad-create-story` (+ `bmad-create-story:validate`) → `bmad-dev-story` → `bmad-code-review`.
  Never implement a feature, epic, or non-trivial fix by editing source files directly outside
  that cycle, even if a request seems simple, urgent, or "just this once." Feeling fast is not
  a reason to skip it.
- If asked to implement something and no story for it is already `ready-for-dev` in
  `sprint-status.yaml`, STOP and create the story first (or point to the existing one) instead
  of editing code ad hoc. `bmad-quick-dev` is the only sanctioned direct-implementation
  shortcut, and only for work explicitly out of scope of the epics/stories plan — never for an
  epic-sized feature already tracked in `epics.md`.
- Epics/stories can carry an explicit go/no-go hold in `epics.md` (e.g. "do not begin
  implementation of any story until explicit go-ahead"). Treat that as a hard block: a plan
  existing is not itself permission to start coding it.
- The moment code lands, `sprint-status.yaml` must reflect it in the same session
  (`ready-for-dev` → `in-progress` → `review` → `done`). Do not let the tracked plan drift out
  of sync with what's actually in the repo.
- If work is ever discovered to have shipped outside this cycle, it must be (a) recorded in
  `sprint-status.yaml` as an as-built entry and (b) run through `bmad-code-review`
  retroactively before being considered `done` — never left un-reviewed just because it already
  merged. See Epic 8 (planned and fully implemented in one day, 2026-07-17, bypassing its own
  "await go-ahead" hold and per-story review, only reconciled on 2026-07-20) for exactly the
  failure mode this rule exists to prevent.

## Dependencies & install config (do NOT touch without explicit approval)

The following are OFF-LIMITS during story implementation. Changing them is never part of a
story unless the story text explicitly says so — if you think you need to, STOP and hand
back to the orchestrator with the exact error instead of editing:

- **Do not change dependency versions** in `package.json` (they are pinned exact on purpose),
  and do not add/remove dependencies.
- **Do not edit `pnpm-lock.yaml`, `pnpm-workspace.yaml`, or create/edit `.npmrc`.** Do not
  add `overrides`, `shamefully-hoist`, `public-hoist-pattern`, a custom `registry`, or any
  other install tuning.
- **Do not run** `pnpm add`, `pnpm up`, `pnpm install <pkg>`, or delete `node_modules` /
  the lockfile to "fix" a resolution problem.
- A build/typecheck error that looks dependency-related (`ERR_PACKAGE_PATH_NOT_EXPORTED`,
  `Cannot find module`, `TS2589 type instantiation is excessively deep`, missing `dist`,
  peer-dependency warnings) is almost always a dependency-tree issue for the orchestrator to
  resolve — NOT something to patch by bumping versions or hoisting packages. Report it and
  stop; do not thrash.

## Code standards

- Node 20+, **ESM only**, TypeScript `strict`, compiled to `dist/` via `tsc`.
- NodeNext resolution: relative imports use the `.js` extension in the specifier even
  though the source is `.ts` (e.g. `import { SCHEMA_VERSION } from "../index.js";`).
- Pin exact dependency versions (no `^`/`~`). Do not add dependencies a story/task does
  not explicitly authorize.
- Follow `docs/architecture.md`, `docs/scaffold-spec.md`, and
  `_bmad-output/planning-artifacts/epics.md` literally. Do not rename or relocate scaffold
  paths — add behaviour to existing files.
- Persisted JSON carries `schemaVersion`. Error envelope is `{ code, message, details? }`.

## Workflow / division of labour

- **Planning, story authoring, code review, and sprint tracking** are done by the
  orchestrating BMAD agent.
- **Implementation is delegated to the local model.** When implementing a story:
  - Do exactly what the story file specifies — exact files, signatures, and steps. Do not
    add scope, invent structure, or "improve" placeholder stubs.
  - Run the story's verification commands (`pnpm run typecheck`, `pnpm run build`,
    `pnpm test`) and report real results — never claim completion without them passing.
  - Update the story's Dev Agent Record (File List, Completion Notes) truthfully.
- When done, set the story Status to `review`; the orchestrator runs `code-review`.

## Coding practices (these are what review will check)

### Correctness & types
- **`async` for anything typed `Promise<...>`.** A function that returns a promise must be
  `async` (or return an actual promise) — never a sync function that just `throw`s. A
  `throw` in a non-async promise-typed function breaks `.catch()` callers.
- No `any`. Prefer `unknown` + narrowing. Let inference work; annotate public boundaries.
- Derive types from a single source of truth (e.g. `z.infer<typeof Schema>`), don't
  hand-duplicate a shape and its schema.
- Validate all external input (tool params, file contents, IPC messages) with Zod at the
  boundary; trust nothing that crosses a process or network edge.

### Errors & failure
- Use the standard error envelope `{ code, message, details? }` and the `ErrorCode` union
  in `src/types/errors.ts`. Tool/daemon errors return structured responses — **never crash
  the daemon**.
- **Correctness over cleverness** (architecture invariant 5): when a decision is uncertain
  (unknown file, stale/missing map, unmeasurable test), fall back to the safe option (full
  suite). Never silently skip.
- Fail loud and specific: error messages say what failed and the actionable fix. No empty
  `catch {}` that swallows errors.

### Files, I/O, security
- Central daemon state lives in `~/.test-mcp/` (override via `TEST_MCP_HOME`); per-project
  state in `<git-root>/.test-mcp/`. Never write project state into the central dir or vice
  versa.
- Secrets (bearer token) are written mode `0600`; never log them.
- Servers bind `127.0.0.1` only — never `0.0.0.0`.
- Prefer Node built-ins over new deps for filesystem/process/crypto/http work.

### Logging
- Structured logs go to **stderr**. `stdout` is reserved for stdio JSON-RPC — do not
  `console.log` diagnostics from the daemon/transport path. (CLI user-facing messages to
  stdout are fine.)

### Comments & style
- Comments explain **why** (intent, trade-offs, constraints), never **what** the code
  obviously does. Delete narration like `// increment counter`. No commented-out code.
- Match existing file style and naming. Small, focused functions.

### Tests
- Every behavioural change ships with tests. Make them **hermetic** — use temp dirs
  (`TEST_MCP_HOME`) and never touch the real `~/.test-mcp/` or bind fixed ports you don't
  control (use port `0` when you need a free one).
- Always release resources in teardown (close servers/handles, kill child processes) so
  the test run doesn't hang or leak ports.
- Assert real behaviour, not implementation trivia. Don't weaken/skip a failing test to go
  green — fix the code.

### Scope discipline
- Change only the files the task authorizes. If you spot unrelated issues, note them for
  the orchestrator instead of fixing them inline.
- Do not create files unless required (no unsolicited READMEs, docs, or scratch files).
- Do not "fix" intentional placeholders (e.g. Story 1.0's `z.object({})` stubs) unless the
  task says so.

### Git
- Do not commit unless explicitly asked. Never commit `node_modules/`, `dist/`, or
  `.test-mcp/` (all git-ignored). Commit messages are English, imperative, and explain why.

## Definition of done for a story

1. All acceptance criteria met.
2. `pnpm run typecheck`, `pnpm run build`, and `pnpm test` all exit 0.
3. Only the files the story authorizes were changed.
4. No new dependencies unless authorized; no unrelated refactors.
5. Story Dev Agent Record updated (File List + Completion Notes) truthfully; Status set to
   `review`.
