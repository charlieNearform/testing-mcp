# Good-Spine Checklist Review — Epic 7 Runner Plugin API

Reviewed:
- Spine: `architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md`
- Parent: `architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md`
- Memlog: `architecture-epic-7-runner-plugin-api-2026-07-16/.memlog.md`
- Code grounding: `src/worker/index.ts`, `src/registry/project-registry.ts`, `src/selection/index.ts`,
  `src/coverage/index.ts`, `src/coverage/combined.ts`, `src/types/contracts.ts`,
  `src/orchestrator/index.ts`, `src/mcp/server.ts`

## Verdict

**Not yet good-spine-clean.** The paradigm framing, code grounding, and inherited-invariant
carry-forward are excellent and precisely accurate against the real source. But two of the new
ADs (AD-12 and AD-15) fail to compose with each other and with one inherited invariant
(AD-1a) in ways that leave real story-level divergence points unresolved — exactly the kind of
gap this epic exists to close. One AD (AD-14) also contains an internal contradiction about
whether an existing field survives.

## 1. Does it fix the real divergence points for stories below, and miss none?

**Partially.** It correctly identifies and fixes the two headline divergence risks the epic
brief cares about: incompatible per-runner reimplementations (AD-12) and suite-vs-suite data
collision (AD-14/AD-15). But it misses two more:

- **RunnerPlugin interface vs. per-suite configPath (see Finding 1).** AD-14 gives every suite
  its own `configPath` specifically so "more than one config file is present" is disambiguated.
  But AD-12's own Rule — the interface signature stories will actually implement against —
  never threads `configPath` (or any suite identity) into `detect`/`listTestFiles`/`run`/
  `affectedTests`/`readCoverageThresholds`. Two suites of the *same* plugin type (e.g. two
  Vitest configs in one repo) have no mechanism in the stated interface to pick the right one.
  This is not hypothetical: the current brownfield code already exhibits exactly this failure
  mode in miniature (see Finding 1's grounding) — `configPath` is computed once at register-time
  for validation only, and is never passed to the runner, which instead relies on Vitest's own
  cwd-based auto-discovery. Epic 7 needs to either add a `configPath` parameter to AD-12's Rule
  or explicitly decide auto-discovery is retired; right now it does neither, so different
  stories (vitest plugin, jest plugin, registry) are free to invent incompatible fixes.

- **Dry-run plan cache is not suite-scoped despite AD-1a's inherited claim (see Finding 2).**
  The inherited-invariants table asserts "Per-suite plans still cache/expire the same way" as
  if this already works, but no AD actually scopes `TestPlan`/the plan cache by suite, and the
  real cache (`orchestrator/index.ts`) validates a committed plan only against `projectId`.

## 2. Is every AD's Rule enforceable, and does it actually prevent its stated divergence?

Mostly yes — AD-13, AD-16, and most of AD-15 are concrete and checkable (existing test suite
passing unmodified; specific capability-string derivation rules). Two exceptions:

- **AD-12** is enforceable as a type shape, but as scoped (see Finding 1) it does *not* prevent
  its own stated divergence ("incompatible per-runner reimplementations... ambiguity over which
  runner applies when more than one config file is present" — that second clause is AD-14's
  prevention claim, but the interface AD-12 hands down structurally can't carry the information
  needed to resolve it).
- **AD-14**'s Rule is internally contradictory about the fate of the existing `configPath` field
  (see Finding 3), which makes it unenforceable as written — a reviewer can't check compliance
  against a rule that asserts two incompatible things.

## 3. Could anything under Deferred let two units diverge?

No problems found. Each Deferred line is either an explicit decision with reasoning (e.g. "no
cross-plugin merge" is a decision, not an open question) or a scope exclusion unlikely to be
independently touched by any Epic 7 story (pytest, Docker escape hatch, function-level
granularity, CRG/Story-6.9). None of these leave two in-scope stories room to build
incompatible versions of the same capability.

## 4. Does it ratify rather than contradict the brownfield codebase?

**Yes, and unusually precisely.** Verified directly against source:

| Spine claim | Code reality | Match |
| --- | --- | --- |
| `runVitest` resolves `vitest/node` at ~L307 | `src/worker/index.ts:307-308` | Exact |
| `buildAndPersistCoverageMap` resolves `vitest/node` at ~L516 | `src/worker/index.ts:516-517` | Exact |
| Functions named `runVitest`/`measureCoverage`/`discoverTestFiles`/`readCoverageThresholds` exist as worker internals | Confirmed at `worker/index.ts:302, 413, 457, 471` | Exact |
| `thresholdsMet` gating "only set at confidence high" at `combined.ts:269-271` | `src/coverage/combined.ts:269-271` — `const thresholds = ...269; const thresholdsMet = ...270-271` | Exact |
| `Confidence` is `{level:'high'\|'degraded', reasons}`, single source of truth for selection + combined | `src/types/contracts.ts:10-13`, imported by both `selection/index.ts` and `coverage/combined.ts` | Exact |
| `RegisteredProject` is `{projectId, path, configPath, status}`, one config per project, no suite notion, registry.json keyed by projectId only | `src/registry/project-registry.ts:18-23`, `RegistryFile.projects: Record<projectId,...>` | Exact |
| `SelectionEngine.plan`/`CoverageMapFile` implicitly single-project-root scoped, no suite/config id threaded | Confirmed, `selection/index.ts` / `coverage/index.ts` | Exact |

This is a genuinely well-grounded spine — the line numbers and shapes are not approximate, they
are correct to the line.

## 5. Does any new AD weaken or contradict an inherited invariant?

No. AD-7's wording generalization ("a project's Vitest" → "a project's runner, of any kind") is
handled correctly: amended in place in the parent (id kept stable, `updated` bumped), the
isolation invariant itself (fork per project, resolve from that project's own tree) is
unchanged, and the parent's own Deferred section was updated in the same pass to mark Jest
in-progress. This is a legitimate fulfillment of AD-2's stated intent, not a weakening — checked
against both the parent file's current text and the memlog's stated rationale, which agree.

## 6. Is every dimension this altitude owns decided, deferred, or an open question?

No — see Findings 1 and 2 above; both are dimensions Epic 7 unambiguously owns (the plugin
interface shape; which persisted contracts become suite-scoped) that are neither decided
correctly, deferred, nor flagged as open questions. They are simply absent from the Rule text
that lists what changes.

---

## Findings

### Finding 1 (HIGH) — AD-12's RunnerPlugin interface can't carry per-suite config identity that AD-14 requires
- **File:** `architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md`, AD-12 (line ~85) and AD-14 (line ~95)
- **Summary:** AD-14 stores a `configPath` per suite specifically to disambiguate "more than one config file is present," but AD-12's Rule — `detect(projectRoot)`, `listTestFiles(projectRoot)`, `run(projectRoot, testFiles, opts)`, `affectedTests?(projectRoot, changedFiles)`, `readCoverageThresholds?(projectRoot)` — never accepts a `configPath` or suite identity. Nothing in the stated interface lets a plugin know *which* of a project's several same-type configs to target.
- **Failure scenario:** A project registers two Vitest suites (`unit` → `vitest.config.unit.ts`, `e2e` → `vitest.config.e2e.ts`). The dispatcher calls `vitestPlugin.run(projectRoot, testFiles, opts)` for either suite with an identical signature; Vitest auto-discovers a config from `projectRoot` (as the current code already does — see below) and picks whichever config it finds first, silently running the wrong suite's tests against the wrong config, or always the same one.
- **Code grounding confirming this is not hypothetical:** in the current brownfield code, `resolveVitestConfig()` (`src/registry/project-registry.ts:53-63,172`) computes `configPath` purely to validate at `register()` time; it is never read again — not by `list()` (`RegistrySummary` omits it), not by the orchestrator (`ProjectRef = {projectId, path}`, `orchestrator/index.ts:27-30`, has no `configPath` field at all), and not by the worker. `runVitest(cwd, opts)` (`worker/index.ts:302-308`) calls `startVitest`/`createVitest` with no `config`/`configFile` option — Vitest resolves its own config purely from `cwd`. So today, with exactly one config per project, this is invisible; the moment AD-14 allows more than one config per project, the missing plumbing becomes a correctness bug, and AD-12's Rule as written doesn't add it.
- **Fix direction (not prescribing the story, just naming the gap):** AD-12's Rule needs a `configPath` (or equivalent) parameter threaded through the calls that need to resolve a specific runner config, and AD-13's "verbatim move" claim needs to acknowledge that `runVitest`/`buildAndPersistCoverageMap` will gain a new parameter they don't have today (a small, legitimate exception to "zero behavior change" that should be named, not left implicit).

### Finding 2 (MEDIUM-HIGH) — TestPlan/dry-run cache omitted from AD-15's suite-scoping list, contradicting AD-1a's inherited-invariants claim
- **File:** `ARCHITECTURE-SPINE.md`, AD-15 (line ~100) and the Inherited Invariants table's AD-1a row (line ~53)
- **Summary:** The Inherited Invariants table asserts "Per-suite plans still cache/expire the same way," which only makes sense if a cached plan carries a suite identity. But AD-15's Rule lists exactly three things that become suite-scoped — `SelectionEngine.plan`, `CoverageMapFile`, `CombinedCoverage` — and `TestPlan` (the dry-run/commit contract, AD-1a) is not one of them.
- **Failure scenario, confirmed against the real plan cache:** `Orchestrator.plans` (`orchestrator/index.ts:133`) is `Map<string, StoredPlan>` keyed only by `planId`; `runPlan` (`orchestrator/index.ts:239-244`) validates a commit only via `stored.projectId !== project.projectId`, and `ProjectRef` (`orchestrator/index.ts:27-30`) is `{projectId, path}` — no suite field anywhere in the chain. `TestPlan` itself (`src/types/contracts.ts:102-117`) has `projectId` but nothing else identifying a suite. Once a project has two suites, a `dryRun` call for suite A and a `run_tests({planId})` commit intended for suite B pass the exact same `projectId` validation — the orchestrator has no way to reject (or even detect) a cross-suite plan commit. This is precisely the failure mode AD-15 exists to prevent ("one suite's ... data being attributed to a different suite"), just in the one persisted/cached contract AD-15 forgot to name.
- **Fix direction:** Either add `TestPlan`/`StoredPlan`/`ProjectRef` to AD-15's suite-scoped list explicitly, or add an AD-1a amendment note (parallel to the AD-7 amendment) stating the plan cache gains a `suiteName` dimension too.

### Finding 3 (MEDIUM) — AD-14's Rule is internally contradictory about whether `RegisteredProject.configPath` survives
- **File:** `ARCHITECTURE-SPINE.md`, AD-14 (line ~95)
- **Summary:** The Rule reads: "`RegisteredProject` gains `suites: ...` **additive** to its existing `projectId`/`path`/`status` — no existing field removed or renamed." The current, real `RegisteredProject` (`src/registry/project-registry.ts:18-23`) has **four** fields: `projectId`, `path`, `configPath`, `status`. The Rule's own enumeration of what's preserved ("projectId/path/status") silently drops `configPath` from the list, while the same sentence insists nothing existing is removed — these two clauses of one Rule contradict each other on the one field that matters most for this AD.
- **Failure scenario:** One story implementing AD-14 keeps top-level `configPath` as a "default suite" pointer for backward compatibility (satisfying "no field removed"); another story removes it because it reads "additive to projectId/path/status" as the complete preserved set and treats `configPath` as superseded by `suites`. Both are defensible readings of the same Rule text, and they produce incompatible `RegisteredProject` shapes and incompatible migration behavior for every already-registered brownfield project (whose `registry.json` today has `configPath` but no `suites` at all — the spine also never specifies a migration path for these pre-existing entries, an omission worth folding into whichever fix is chosen here).
- **Fix direction:** State explicitly whether `configPath` (a) stays as a legacy/default-suite alias, (b) is deprecated-but-still-round-tripped for one version, or (c) is dropped outright with a stated migration (e.g. auto-backfill a `default` suite entry from the old `configPath` on next `register()`/load).

### Finding 4 (LOW) — pre-existing dead `suite` parameter on `run_tests` not reconciled
- **File:** `src/mcp/server.ts:119` (code, not the spine) vs. `ARCHITECTURE-SPINE.md` AD-14
- **Summary:** The `run_tests` MCP tool already declares `suite: z.string().optional().describe("Test suite name")`, but it is not destructured or used anywhere in the handler (`server.ts:124` destructures `projectId, files, mode, coverage, since, strict, dryRun, planId` — no `suite`). The spine's structural seed and AD-14 don't mention this existing, unwired parameter. It's low risk (dead code, not a divergence point by itself) but worth a line in the spine so a story doesn't accidentally collide with or duplicate it when wiring real suite selection into `run_tests`.
