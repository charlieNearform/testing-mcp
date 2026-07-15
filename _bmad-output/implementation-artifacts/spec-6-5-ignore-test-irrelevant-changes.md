---
title: 'Story 6.5 — Ignore test-irrelevant file changes in selection'
type: 'feature'
created: '2026-07-15'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
baseline_revision: 'e31f7c8a52968aeb907d8c498d049f1664145b64'
final_revision: '546fcc53c24a1a8a3bc6228a4097ef66b967f59e'
---

<intent-contract>

## Intent

**Problem:** Incremental selection diffs the whole changed set, including files that cannot affect a JS/TS test run (docs/markdown, VCS/editor/agent dotfiles like `.gitignore`, `.mcp.json`, `CLAUDE.md`). Any such edit is "unknown to the map" → forces a full suite, and there is no way to exclude project-specific noise.

**Approach:** Filter the changed-file set to drop provably test-irrelevant paths — a built-in non-code/dotfile default set plus an optional project `<git-root>/.test-mcp-ignore` (gitignore-style). A **keep-always allowlist** (code + build/test config) is checked *first* so those are never dropped. Filtering lives in `getChangedFiles` (the only place with the project root); `plan()` stays pure and an all-filtered change naturally collapses to the existing "no changes detected" no-op — not a full suite.

## Boundaries & Constraints

**Always:** The keep-always allowlist is checked BEFORE any ignore rule and its members are never dropped: any `*.{js,jsx,ts,tsx,mjs,cjs}` file, `package.json`, lockfiles (`pnpm-lock.yaml`/`package-lock.json`/`yarn.lock`), `*.config.{js,ts,mjs,cjs}`, `tsconfig*.json`, `vitest.setup.*`. Filtering happens inside `getChangedFiles`; `SelectionEngine.plan` branch logic is unchanged. Node built-ins only. An all-filtered changed set becomes `[]` → the existing "no changes" incremental no-op. `pnpm run typecheck`, `pnpm build`, `pnpm test` pass.

**Block If:** the work appears to need a new dependency (e.g. `ignore`/`minimatch`) — HALT (dependencies are orchestrator-authorized). Or it appears to need changes to `plan()`'s branches or the coverage map — out of scope; HALT.

**Never:** never drop a code file or build/test config, even if a user `.test-mcp-ignore` pattern would match it (invariant-5 safety net). Do not change which tests run for a genuinely-relevant change. Do not add dependencies. Do not implement full gitignore semantics beyond the documented forms — document any omitted (e.g. `!` negation) rather than half-supporting them.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Only non-code changed | `README.md`, `.gitignore`, `CLAUDE.md` changed; incremental | all filtered → `[]` → "no changes detected" no-op (strategy `incremental`, `total` 0); NOT full | none |
| Non-code + real (unmapped) source | `README.md` + `src/x.ts` changed | `src/x.ts` survives → normal selection (full/map) as today | none |
| `.test-mcp-ignore` custom pattern | file has `*.snap`; a `foo.snap` changed | `foo.snap` filtered out; if nothing else changed → no-op | none |
| Ignore pattern vs keep-always | `.test-mcp-ignore` has `*.json`; `package.json` changed | keep-always wins → `package.json` survives → triggers selection | none |
| Code file never filtered | `src/foo.ts` changed | never dropped; drives selection | none |
| Malformed / comment / blank lines in ignore file | `# c`, ``, `  ` | comments/blank ignored by parser; no crash | tolerate; ignore file unreadable → treat as absent |

</intent-contract>

## Code Map

- `src/selection/index.ts` -- `getChangedFiles` (apply the filter before returning; read `<projectRoot>/.test-mcp-ignore`); NEW: a keep-always allowlist, a built-in default ignore set, a minimal gitignore-style matcher, and an exported pure helper (e.g. `filterChangedPaths(files, patterns)`) for unit-testing.
- `src/orchestrator/index.ts` -- REFERENCE: `resolveSelection` calls `getChangedFiles(project.path)` (git root); no change.
- `test/selection.test.ts` -- unit tests for the pure filter (defaults, keep-always, matcher forms, comments).
- `test/git-selection.test.ts` -- integration cases (no-op on non-code; full on real source; `.test-mcp-ignore`; keep-always for `package.json`).

## Tasks & Acceptance

**Execution:**
- [x] `src/selection/index.ts` -- added `isKeepAlways` (code exts + `package.json`/lockfiles/`tsconfig*.json`/`vitest.setup.*`; `*.config.{js,ts,mjs,cjs}` subsumed by the code-extension rule) checked first; exported `DEFAULT_IGNORE_PATTERNS` (the spec's default set); a minimal `globToRegExp` matcher (blank/`#` lines, bare names, `*`→`[^/]*`, `dir/**`, leading-`/` anchoring; `!`/`?` documented unsupported); `readIgnorePatterns(projectRoot)` for `.test-mcp-ignore` (missing/unreadable → `[]`); exported pure `filterChangedPaths(files, patterns)` applied in `getChangedFiles` before `return unique(...)`. All-filtered → `[]` → existing "no changes detected" branch; `plan`/orchestrator/coverage-map untouched.
- [x] `test/selection.test.ts` -- pure unit cases for `filterChangedPaths` (defaults, keep-always vs matching pattern, matcher forms, comments/blanks).
- [x] `test/git-selection.test.ts` -- 4 real-git integration cases: only-`README.md` → incremental no-op; `README.md` + unmapped source → full; `.test-mcp-ignore` non-code pattern → no-op; `package.json` → still triggers.

**Acceptance Criteria:**
- Given only test-irrelevant files changed, when an incremental run executes, then it collapses to the no-op "no changes" path (nothing runs), not a full suite.
- Given a `.test-mcp-ignore` pattern matching a changed non-code file, when incremental runs, then that file is excluded from the changed set.
- Given a changed code file or build/test config (even if a user ignore pattern would match it), when incremental runs, then it is NOT dropped and drives selection normally.
- Given a mix of ignored and relevant changes, when incremental runs, then only the relevant changes drive selection.

## Design Notes

Filtering belongs in `getChangedFiles` because it is the only function holding `projectRoot` (needed to read `.test-mcp-ignore`), and dropping paths there means `plan()` is untouched — an all-filtered result is `[]`, which `plan()` already maps to `"no changes detected"` (incremental, empty) and the orchestrator short-circuits to a no-op run. The keep-always allowlist is the load-bearing safety net for invariant 5: a user ignore pattern must never suppress a code/config file that could change test behaviour, so it is checked before the ignore rules. Keep the pure `filterChangedPaths` exported so the matcher + allowlist are unit-testable without git. (When Story 6.7's since-last-run baseline lands, it should reuse this same filter on its changed set.)

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm build` -- expected: exit 0
- `pnpm test` -- expected: exit 0; new selection-filter unit + git-selection integration cases pass

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 1, low 0)
- defer: 3: (high 0, medium 2, low 1)
- reject: 2: (high 0, medium 0, low 2)
- addressed_findings:
  - `[medium]` `[patch]` keep-always matched `.js/.jsx/.ts/.tsx/.mjs/.cjs` but not `.mts`/`.cts` (which `isTestFile` recognizes) and was case-sensitive — a changed `.mts` test could be dropped by a user pattern. Fixed regex to include `mts|cts` + `/i`; added a regression test.
  - deferred: (1) non-code fixture edits can be a silent no-op → 6.8 should surface fully-filtered changesets; (2) matcher supports a documented subset only (unsupported forms fail toward more running); (3) keep-always not exhaustive for all build/test configs + `readIgnorePatterns` swallows non-ENOENT errors. → deferred-work.md.
  - rejected (by design/documented): `!` negation & `?`/`[…]` (documented unsupported); a user `.test-mcp-ignore` dropping their own fixtures (their choice, like `.gitignore`).

## Auto Run Result

Status: done

**Change:** Incremental selection now filters test-irrelevant paths out of the changed set (built-in non-code/dotfile defaults + optional `<git-root>/.test-mcp-ignore`), so an unrelated docs/dotfile edit collapses to the "no changes" no-op instead of forcing a full suite. A keep-always allowlist (code + build/test config, checked first) guarantees a user pattern can never drop a file that could change test behaviour.

**Files changed:**
- `src/selection/index.ts` -- `filterChangedPaths` (pure, exported) + `isKeepAlways` + `DEFAULT_IGNORE_PATTERNS` + minimal `globToRegExp` + `readIgnorePatterns`; applied in `getChangedFiles`. Review patch: keep-always now covers `.mts`/`.cts` and is case-insensitive.
- `test/selection.test.ts` -- pure unit cases (defaults, keep-always incl. mts/cts, matcher forms, comments).
- `test/git-selection.test.ts` -- 4 real-git integration cases (non-code no-op; real source → full; `.test-mcp-ignore`; `package.json` keep-always).

**Review:** Blind Hunter + Edge Case Hunter (parallel). 1 patch applied (mts/cts keep-always gap), 3 deferred (fixture-observability → 6.8; matcher subset; keep-always/error-handling gaps), 2 rejected as by-design.

**Follow-up review recommended:** false — the only fix landed this pass was a one-line keep-always regex extension + test; substantive concerns were deferred, not changed.

**Verification:** `pnpm run typecheck` exit 0; `pnpm build` exit 0; `pnpm test` exit 0 (36 files, 138 tests).

**Residual risks:** the deferred fixture-driven false-no-op (mitigation belongs to 6.8's confidence signal); the matcher's documented unsupported gitignore forms (fail safe toward more running).
