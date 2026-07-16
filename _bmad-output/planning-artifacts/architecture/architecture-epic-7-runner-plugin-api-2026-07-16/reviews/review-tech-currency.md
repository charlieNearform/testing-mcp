# Tech-Currency Review — Epic 7 Runner Plugin API Spine

**Reviewed:** `ARCHITECTURE-SPINE.md` (architecture-epic-7-runner-plugin-api-2026-07-16)
**Method:** cross-checked every named technology/API claim against the actual repo (grep/read)
and public docs/source (Jest official docs, Jest GitHub source, npm registry), rather than
trusting training-data recall.

## Verdict

Most claims check out exactly (line numbers, existing code patterns, parent-spine cross-refs,
package versions all confirmed real), but **AD-16's two central Jest CLI/API claims are each
wrong or unverified in a way that matters**: Jest has no `--changed` flag, and `--coverage
--json` does not do what the spine says it does — both need correction before this is treated
as validated.

## Findings

### 1. HIGH — `--changed` is not a real Jest flag (AD-16)

AD-16's rule text says the Jest plugin's `changedFileDetection` capability should track "Jest's
own `--changed`/`--listTests` CLI flags." **`--changed` does not exist.** Confirmed against the
official CLI docs (jestjs.io/docs/cli): the relevant flags are `--onlyChanged` (alias `-o`,
git/hg working-tree diff) and `--changedSince <branch-or-commit>` (diff against a ref). Neither
is spelled `--changed`. `--listTests` is real and behaves as assumed ("Lists all test files that
Jest will run given the arguments, and exits").

This is a naming error, not just typo-level: `--onlyChanged` and `--changedSince` have different
semantics (working-tree vs. ref-based diff), and AD-16 doesn't say which one the plugin should
use. Fix: name the actual flag(s) and pick one (or both, gated by whether a base ref is
supplied) before implementation.

### 2. HIGH — `--coverage --json` does not map to `CoveragePct`; the spine conflates two independent mechanisms

AD-16 gates `capabilities.coverage === "summary"` on "Jest's `--coverage --json` output maps to
`CoveragePct` without a new runtime dependency." This combination doesn't do what's implied:

- `--json` controls the **test-result** reporter: "Prints the test results in JSON. This mode
  will send all other test output and user messages to stderr" (official docs). It is orthogonal
  to coverage file generation.
- Coverage output is governed by the separate `coverageReporters` config (Istanbul-based;
  default `["clover","json","lcov","text"]`), which already includes a `"json"` reporter that
  writes `coverage-final.json` to disk — independent of whether `--json` is passed at all.
- Jest's `AggregatedResult`/`FormattedTestResults` types (the shape `--json` actually prints)
  do carry an optional `coverageMap` field, but it's typed as the **raw** `CoverageMap` from
  `istanbul-lib-coverage` (statement/branch maps) — not a pre-computed `CoveragePct`
  (statements/branches/functions/lines `%`). Getting from either the raw `coverageMap` or
  `coverage-final.json` to `CoveragePct` requires the same summarization step either way
  (`istanbul-lib-coverage`'s per-file `.toSummary()`), regardless of which flag combo produced
  the raw data.

**The good news:** the spine's actual bar — "summary capability without a new runtime
dependency" — is achievable, just not via the mechanism it names. `istanbul-lib-coverage@3.2.2`
is **already a pinned dependency** of this repo (`package.json`), already used to parse
Vitest's raw `coverage-final.json` in exactly this shape
(`src/worker/index.ts:436`, comment at 442: "Return the raw istanbul-shaped data too... for the
combined-coverage merge"). Since Jest's default `coverageReporters` already emits
`coverage-final.json` in the same raw Istanbul format (with `--coverage` alone, no `--json`
needed), the Jest plugin can reuse the exact same `istanbul-lib-coverage` summarization path
already proven for Vitest — no new dependency required. Recommend AD-16 be corrected to cite
`coverage-final.json` (via default `coverageReporters`) + the existing `istanbul-lib-coverage`
dependency, not "`--coverage --json`."

### 3. MEDIUM-HIGH — "resolved the same `projectRequire` way Vitest is today" glosses over a real asymmetry (Stack table)

The Stack table asserts Jest is "project-resolved; no daemon-side pin, resolved the same
`projectRequire` way Vitest is today." Verified the actual code: `projectRequire` isn't a shared
utility, it's `createRequire(path.join(cwd, "__test-mcp-resolve__.js"))` re-created inline at
each of the two vitest call sites (`src/worker/index.ts:307`, `516`), which then does
`projectRequire("vitest/node")` — and `vitest/node` is a **purpose-built embeddable API**
(`startVitest`/`createVitest`, designed to be driven in-process).

Jest has no equivalent top-level embeddable entry point. The plain `jest` package's CLI `run()`
(`packages/jest-cli/src/run.ts`, confirmed from source) calls `exit()` (via the `exit-x`
package) after a run completes/fails — i.e. resolving `jest` the naive way and calling its
`run()` risks terminating the daemon's forked worker process. The actual non-exiting API that
returns a structured `AggregatedResult` is `runCLI`, exported from **`@jest/core`** — a
different package than `jest` (confirmed: `jest-cli/src/run.ts` imports
`{ runCLI } from '@jest/core'`). Whether `@jest/core` resolves via `projectRequire` from a
project whose `package.json` only lists `jest` as a direct dependency depends on the target
project's package manager/hoisting: likely fine under npm/yarn classic hoisting, not guaranteed
under strict pnpm (the same phantom-dependency class of failure this repo's own CLAUDE.md flags
as a stop-and-report condition, `ERR_PACKAGE_PATH_NOT_EXPORTED`/`Cannot find module`).

This should be spiked and confirmed (or the plugin's `run()` explicitly implemented against
`@jest/core`'s `runCLI`, with a fallback/error path when it isn't resolvable) rather than
asserted as parity with Vitest's resolution story.

### 4. Confirmed accurate — line numbers, code patterns, cross-references, package facts

Everything else checked was accurate:

- `runVitest` and `buildAndPersistCoverageMap` are at `src/worker/index.ts:302` and `:511`
  respectively, with the cited `projectRequire("vitest/node")` calls at exactly lines **307-308**
  and **516-517** as AD-13 states ("~L307", "~L516").
- `combined.ts:269-271` — the `thresholdsMet` gating pattern ("only set at confidence `high`") is
  exactly as AD-15 describes.
- The parent spine's AD-7 amendment is real and already in place: `architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md:89-91`
  contains the generalized wording plus a back-reference to this Epic 7 spine, matching the
  "Note on AD-7" claim.
- All three `sources` documents exist on disk: the parent spine, `brief.md`, and `docs/prd.md`.
- Package versions/existence: Vitest is pinned at `4.1.9` (npm latest as of this check:
  `4.1.10` — current, not stale). Jest is not pinned (correctly, per the spine — it's
  project-resolved only) and is still an actively published, maintained package (npm latest:
  `30.4.2`), with an `engines` range (`^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0`) compatible
  with this repo's Node 20+ requirement.
- `istanbul-lib-coverage@3.2.2` is a real, currently-pinned dependency in `package.json`
  (supports finding #2 above).

## Sources consulted

- jestjs.io/docs/cli (official Jest CLI reference — flags, `--json`, `--onlyChanged`,
  `--changedSince`, `--listTests`)
- jestjs.io/docs/configuration (`coverageReporters`, `coverageDirectory`)
- github.com/jestjs/jest — `packages/jest-test-result/src/types.ts` (`AggregatedResult`,
  `FormattedTestResults`, `coverageMap` typed via `istanbul-lib-coverage`)
- github.com/jestjs/jest — `packages/jest-cli/src/run.ts` (`run()` → `exit()`; `runCLI` imported
  from `@jest/core`)
- npm registry (`npm view vitest version`, `npm view jest version`, `npm view jest engines`)
- Repo source: `src/worker/index.ts`, `src/coverage/combined.ts`, `package.json`,
  `_bmad-output/planning-artifacts/architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md`
