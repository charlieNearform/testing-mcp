# Sprint Change Proposal — Test-Selection Model Reshape

**Date:** 2026-07-15
**Project:** test-server-mcp
**Author/Driver:** Developer (course-correction), for BMAD User
**Status:** DRAFT — awaiting approval; **no artifacts edited yet**

---

## Section 1 — Issue Summary

**Trigger:** Epic 6 planning + hands-on use of the incremental selection against the
`sanity-check` project.

**Core problem (technical limitation discovered in use):** the incremental model is less useful
than intended, for three compounding reasons:

1. **Baseline too broad.** Selection diffs against **git HEAD**, so a long uncommitted session
   grows the "changed" set without bound and incremental degrades toward a full suite.
2. **Blunt fallback.** Any changed file unknown to the coverage map — including test-irrelevant
   files (`.gitignore`, `.mcp.json`, `CLAUDE.md`, `*.md`) and brand-new source files — forces
   the **full suite** (architecture invariant 5 / step 4). Correct, but frequently wasteful.
3. **No confidence channel.** The tool can only choose "tight but maybe-incomplete" *or* "full";
   it can't run tight **and tell the agent** when a full pass is warranted.

**Evidence:** a run against `sanity-check` reported `total: 6, strategy: "full", reason: "full
suite"` for an incremental request, because `.gitignore`/`.mcp.json`/`CLAUDE.md` were changed
and unknown to the map; adding a new `date.js` + test also forced full. Verified via direct MCP
`run_tests` calls.

---

## Section 2 — Impact Analysis

### Epic impact
- **Epic 6 (Post-v1 Enhancements)** — the home for this work. Stories 6.4–6.7 already authored;
  this proposal updates 6.5/6.6/6.7 and **adds 6.8 (confidence signal)**. No other epic affected;
  Epics 1–5 remain `done`.

### Story impact
- **6.4** (surface real selection reason) — unchanged; observability only.
- **6.5** (ignore irrelevant files) — **update**: default = ignore non-code files; **add** support
  for a project ignore file (gitignore-style).
- **6.6** (new files via static graph) — **reshaped**: "new-vs-modified unmapped source" becomes
  "select tight + flag confidence" rather than "force full for modified-unmapped".
- **6.7** (since-last-run baseline) — **confirm as default** (`since: "last-run"`, opt-out
  `"head"`); snapshot advances only for **validated** files; handle **deletions**.
- **6.8** (NEW) — selection confidence signal.
- **6.9** (optional CRG impact analysis) — unchanged; remains backlog.
- **6.10** (NEW) — combined incremental coverage: maintain a full-project coverage picture by
  merging per-test-file coverage across runs (baseline full run + incremental refreshes), so an
  incremental run can still report/enforce whole-project coverage — with stale (changed but
  un-re-measured) files flagged via the confidence signal. Depends on 6.3 + 6.7 + 6.8.

### Artifact conflicts
- **PRD (`docs/prd.md`) — AFFECTED.** FR13/FR14 acceptance criteria say the system "falls back to
  running the full suite (no silent skip)" / "conservatively runs the full suite rather than risk
  a missed failure", and the success-metrics note (lines ~554–556) says "when uncertain it runs
  the full suite." The confidence-signal model softens this to "select tight, report confidence,
  agent decides." → PRD text must be revised (see Section 4).
- **Architecture (`docs/architecture.md`) — AFFECTED.** Invariant 5, the selection algorithm
  (steps 0/1/4), the Data Model (new `last-run-snapshot.json` + ignore file), and the MCP tool
  contract (`since` flag, opt-out flags, `confidence` field).
- **Epics (`epics.md`), stories, `sprint-status.yaml` — AFFECTED** (add 6.8; update 6.5/6.6/6.7).
- **UX** — N/A (the run-detail/UI confidence surfacing rides on Epic-6 UI stories already planned).

### Technical impact
- New persisted per-project artifact: `.test-mcp/last-run-snapshot.json` (content hashes,
  schema-versioned, git-ignored).
- Optional `.test-mcp-ignore` (gitignore-style) read at selection time.
- `TestResult` gains an optional `confidence` field; `run_tests` gains `since` + opt-out flags.
- `getChangedFiles` must distinguish new/modified/deleted and support a snapshot baseline.

---

## Section 3 — Recommended Approach

**Selected: Direct Adjustment (Option 1) — hybrid within Epic 6.** Update stories 6.5–6.7, add
6.8, and revise the PRD/architecture text. No rollback (nothing is built yet — all of 6.1–6.9
are `ready-for-dev`/`backlog`), no MVP reduction (this refines existing FRs, doesn't drop scope).

- **Effort:** Medium (planning-doc edits now; implementation is the Epic 6 dev cycle).
- **Risk:** Medium — it **softens invariant 5**, a core safety invariant. Mitigated by: keeping a
  conservative full-suite trigger for genuinely-unbounded cases (config changes, setup-baseline,
  unmeasurable tests, no-git), advancing the snapshot only for validated files, and making the
  confidence signal the explicit safety net ("run full before done").
- **Timeline:** No impact on Epics 1–5 (done). Sequences the Epic 6 refinement track.

---

## Section 4 — Detailed Change Proposals (before → after)

### 4.1 Architecture — Invariant 5

**BEFORE:**
> 5. **Correctness over cleverness.** When test selection is uncertain (unknown file, stale map),
> fall back to the full suite. Never silently skip.

**AFTER:**
> 5. **Correctness over cleverness, with an explicit confidence channel.** Prefer the tightest
> *safe* selection and **report confidence**. When impact is genuinely unbounded (build/test
> config changed, a setup-baseline module changed, an unmeasurable test is implicated, or git is
> unavailable) → run the **full suite**. When selection is bounded but not provably complete →
> run the tight set and mark the result **degraded confidence** with reasons, so the caller runs
> a full pass before relying on it. Never silently skip *without signalling*.

### 4.2 Architecture — Selection algorithm

**BEFORE (steps 1–5):** git-HEAD changed set → A = Vitest `--changed` → B = coverage map →
unknown/setup-baseline/unmeasurable ⇒ full → else A ∪ B.

**AFTER:**
> 0. **Filter** provably test-irrelevant paths (non-code: docs/markdown, VCS/editor/agent
>    dotfiles) and any patterns in the project `.test-mcp-ignore`.
> 1. **Changed set** = files changed vs the **last-run snapshot** (default; content-hash) OR vs
>    git HEAD (`since: "head"`), including added/modified/**deleted**.
> 2. `A` = static-graph selection (Vitest `--changed`; HEAD baseline).
> 3. `B` = coverage-map reverse lookup (minus setup-baseline).
> 4. **Unbounded triggers → full suite:** build/test config change (`package.json`, lockfiles,
>    `*.config.*`, `tsconfig*.json`, `vitest.setup.*`), setup-baseline change, unmeasurable test,
>    or no git/static graph. **New/untracked source unknown to the map → bound by `A`** (not
>    full). **Modified-unmapped source → select best-effort + mark degraded confidence.**
> 5. Otherwise run `A ∪ B` (+ tests importing deleted files) and attach a **confidence** verdict.

### 4.3 Architecture — Data Model (additions)

- `last-run-snapshot.json` (repo, `<git-root>/.test-mcp/`, git-ignored): `{ schemaVersion, takenAt,
  files: { <relpath>: <sha256> } }`. Advanced only for **validated** files after a run.
- `.test-mcp-ignore` (repo, optional): gitignore-style patterns excluded from the changed set.
- **Coverage map extended (6.10):** in addition to the source→test reverse mapping, persist
  per-test-file **coverage data** so combined project coverage = union of each test file's latest
  measurement; a file's coverage is invalidated when its source changes (line shifts) and
  refreshed when re-measured. Stale (changed-but-unmeasured) files flag degraded confidence.

### 4.4 Architecture — MCP Tool Contract (`run_tests`)

- Add `since?: "last-run" | "head"` (default `"last-run"`).
- Add opt-out flags for the new defaults (ignore-filter, since-last-run, confidence) — exact flag
  names to be finalized in Story 6.8/6.7.
- `TestResult` gains `confidence?: { level: "high" | "degraded"; reasons: string[] }`.

### 4.5 PRD (`docs/prd.md`) — soften "always full when uncertain"

- **FR13 AC (~line 336)** BEFORE: "Then the system falls back to running the full suite (no silent
  skip)" → AFTER: "Then the system runs the full suite **only for genuinely unbounded changes**;
  for bounded-but-uncertain changes it runs the tight set and **reports degraded confidence** so
  the caller can run a full pass — never a silent skip."
- **FR14 AC (~line 388)** BEFORE: "conservatively runs the full suite rather than risk a missed
  failure" → AFTER: "selects the bounded set and **flags degraded confidence** (full suite only
  for unbounded cases), so a missed failure is surfaced as low confidence rather than silently
  skipped."
- **Success-metrics note (~lines 554–556)** BEFORE: "when uncertain it runs the full suite —
  accepting some wasted runs to avoid missed failures." → AFTER: "when uncertain it selects tight
  and reports confidence; the agent runs a full pass at feature-completion — trading always-full
  for a confidence signal, still never silently skipping."
- Add default-baseline note: incremental compares against the **last run** by default (git-free,
  content-hash), aligning with the previously-noted `vitest --stale` direction; `--changed`/HEAD
  remains available.

### 4.6 Epics / Stories / sprint-status

- **6.5**: default ignore = non-code files; add `.test-mcp-ignore` support (update ACs + notes).
- **6.6**: reframe modified-unmapped as "select + degraded confidence" (defer hard-full to
  unbounded cases); new-file-bound-by-static-graph unchanged.
- **6.7**: `since: "last-run"` default + `"head"` opt-out; validated-only snapshot advance;
  deletion handling in the changed set.
- **6.8 (NEW, ready-for-dev)**: selection confidence signal — `TestResult.confidence`
  (`high`/`degraded` + reasons); degraded when modified-unmapped, unmeasurable test implicated,
  deleted-file impact can't be bounded, or snapshot/base missing; UI run-detail surfaces it.
- **6.10 (NEW, ready-for-dev)**: combined incremental coverage — extend the coverage map to store
  per-test-file coverage data; a full run sets the baseline, incremental runs refresh the test
  files they ran; combined project coverage = union of latest per-test-file coverage; changed
  files invalidate their entry until re-measured; combined report carries a confidence verdict
  (degraded when a changed file is unmeasured) so 100%-enforcement/thresholds stay honest. Depends
  on 6.3 (coverage report), 6.7 (snapshot/change model), 6.8 (confidence).
- **sprint-status.yaml**: add `6-8-selection-confidence-signal` and
  `6-10-combined-incremental-coverage` as `ready-for-dev`.
- **Order:** 6.4 → 6.5 → 6.6 → 6.7 → **6.8** → 6.1 → 6.2 → 6.3 → **6.10** (6.9 backlog).

---

## Section 5 — Implementation Handoff

**Scope classification: Moderate** (backlog + planning-doc reorganization; touches PRD wording +
a core architecture invariant, but no rollback and no MVP scope cut).

- **This proposal (on approval):** Developer applies the doc edits — architecture.md, prd.md,
  epics.md, story files 6.5/6.6/6.7, new 6.8, sprint-status.yaml.
- **Then:** normal Epic 6 story cycle — `bmad-dev-story` down the order (6.4 first), each
  followed by `bmad-code-review`, in fresh contexts.
- **Success criteria:** architecture invariant 5 + selection algorithm + PRD FR13/14 consistently
  describe the confidence model; stories 6.5–6.8 are internally consistent and dev-ready;
  sprint-status reflects 6.8.

**PRD note for the owner:** because FR acceptance criteria change, this is a PM/architect-level
sign-off, not just a dev edit — hence surfacing it explicitly for approval.
