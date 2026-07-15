# Story 6.6: New Source Files Bounded by the Git Static Graph (not full suite)

**ID:** `6-6`
**Slice:** `src/selection`
**Type:** `feature`
**Depends on:** `6-0` (independent of 6.4/6.5; complements them)
**Status:** ready-for-dev

## Source

Observed 2026-07-15: adding a **new** source file and its new test (`src/date.js` +
`test/date.test.js`, both untracked) triggered a **full** suite. Cause: the new source is
unknown to the coverage map, and the engine's rule is "changed source unknown to map → full"
(`docs/architecture.md` selection algorithm step 4; Story 3.5). That is *as specified*, but too
blunt: a brand-new file had no runtime dependents before it existed, so Vitest's `--changed`
static-import graph already bounds its impact (its new test, plus any existing test that
statically imports it). A full run is unnecessary for the common "add a feature + its test" flow.

- Related: `src/selection/index.ts` (`SelectionEngine.plan`, `getChangedFiles`), Story 3.1
  (git `--changed`), Story 3.5 (union + fallback), `docs/architecture.md` invariant 5 + step 4.

## Acceptance criteria

1. **Given** the only changes are a new (untracked/added) source file and its new test file, and
   a coverage map exists
   **When** an incremental run is planned
   **Then** the run is bounded by the git `--changed` static-graph selection (includes the new
   test and any existing test that statically imports the new source) — **not** the full suite.

2. **Given** a new source file that is statically imported by an existing test
   **When** selection runs
   **Then** that existing test is included (via the static graph), so nothing that actually
   depends on the new file is missed.

3. **Given** a **modified existing** source that is unknown to the map (e.g. never measured /
   measurement failed) — as opposed to a brand-new file
   **When** selection runs
   **Then** behaviour is unchanged from today (still conservative — full suite), unless the
   architecture reconciliation (below) decides otherwise. This story targets **new** files.

4. **Given** a setup-baseline module change, an unmeasurable-test trigger, or git/static-graph
   being unavailable
   **When** selection runs
   **Then** the conservative full-suite fallback still applies (invariant 5 preserved for
   genuinely unbounded cases).

## Out of scope

- Changing coverage-map building or measurement.
- Broadening the relaxation to modified-but-unmeasured existing sources (AC3 keeps those
  conservative) unless the architecture reconciliation explicitly extends it.
- Dynamic-import / runtime-only coupling of a new file (not in the static graph and not in the
  map either — genuinely undetectable until the file is measured; document the residual risk).

## Notes for the agent

- `getChangedFiles` currently returns a flat list (tracked `git diff --name-only HEAD` +
  untracked `git ls-files --others --exclude-standard`) with no new-vs-modified tag. To
  implement AC1/AC3 you likely need to **distinguish new/untracked from modified** — untracked
  entries are the "new files". Consider returning a tagged shape (e.g. `{ path, isNew }[]`) or a
  separate untracked set, and keep `SelectionEngine.plan` pure over that richer input.
- In `plan`, when the only unknown-to-map changed sources are **new** files, prefer the
  `changed-only` / git-`--changed` static-graph path (Story 3.1) — optionally unioned with the
  coverage-map result for the *known* changed sources — instead of returning `full`.
- Keep the reason precise (works with 6.4): e.g. "new file bounded by git --changed:
  `<file>`" vs. today's "changed source unknown to coverage map".
- Add pure unit tests: new source + new test → not full (bounded set); new source imported by an
  existing test → that test included; modified unmapped source → still full; setup-baseline
  change → still full.

## Escalation triggers

- **This narrows a documented rule (architecture step 4 / invariant 5).** Before implementing,
  reconcile with the architecture spine: confirm that "new/untracked source unknown to the map"
  is safe to bound by the static graph rather than full-suite, and record the decision (a
  `bmad-correct-course` or an architecture-doc update may be warranted). If the safety argument
  for AC1 doesn't hold for some case, keep it conservative and escalate.
