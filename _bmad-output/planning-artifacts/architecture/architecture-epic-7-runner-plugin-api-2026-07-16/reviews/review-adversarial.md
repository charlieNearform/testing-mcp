# Adversarial Review — Epic 7 Runner Plugin API Spine

**Target:** `_bmad-output/planning-artifacts/architecture/architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md`
**Method:** for each AD, construct two units-one-level-down that can each satisfy the Rule text literally, then check whether the *composition* of their compliant choices still integrates. Findings are grounded against the actual pre-Epic-7 code (`src/orchestrator/index.ts`, `src/mcp/server.ts`, `src/registry/project-registry.ts`, `src/coverage/index.ts`, `src/coverage/combined.ts`, `src/worker/index.ts`) since the spine's Rules are phrased as diffs against that code, not against a clean slate.

**Verdict:** the spine is directionally sound but under-specifies ownership at the seam between the (correctly) suite-scoped coverage/selection core and the *unscoped* orchestrator/MCP-tool-surface layer that sits above it — that seam is where two independently AD-compliant implementers most plausibly produce a system that silently cross-attributes one suite's state to another, with no AD forbidding it because neither AD names the orchestrator layer as bound at all.

---

## Finding 1 (severity: high) — Orchestrator bookkeeping is keyed by `projectId` alone and is not named in AD-15's `Binds`, so it will not get suite-scoped by anyone who reads the spine literally

**AD-15's `Binds:`** line reads "selection, coverage, combined coverage, confidence." It does **not** say "orchestrator." Its Rule text lists exactly three things that gain a `suiteName` dimension: `SelectionEngine.plan`, `CoverageMapFile`, `CombinedCoverage`.

But `src/orchestrator/index.ts` today holds four private stores, every one keyed by bare `projectId: string`, that back the entire client-visible run lifecycle:

```
private readonly queues = new Map<string, Promise<unknown>>();               // line 129 — per-project run serialization
private readonly lastFailures = new Map<string, Map<string, FailureDetail>>(); // line 131
private readonly plans = new Map<string, StoredPlan>();                       // line 133 (keyed by planId, ownership-checked via stored.projectId, line 240)
private readonly runState = new Map<string, RunStatus>();                     // line 135
private readonly history = new Map<string, RunRecord[]>();                    // line 137
```

`getRunStatus(projectId)`, `getFailureDetail(projectId, failureId)`, `getRunHistory(projectId)`, `loadHistory(projectId, projectPath)`, and `recordRun(record, projectPath)` (`this.history.set(stored.projectId, list)`) all take/key on `projectId` only — no `suiteName` anywhere in these signatures. The MCP tool surface mirrors this exactly: `src/mcp/server.ts` — `get_status` (line 168), `get_failure_detail` (line 224), `run_tests` (line 124) — every `inputSchema` takes `projectId: z.string()`. Tellingly, `run_tests`'s schema *already* has a `suite: z.string().optional()` field (line 119) that the handler at line 124 never destructures or forwards — a live, present-day stub that nobody wired up.

**Two units, both AD-compliant:**
- **Unit A (coverage/selection owner):** does exactly what AD-15 says — adds `suiteName` to `CoverageMapFile`, `CombinedCoverage`, and the plan's stored shape, and namespaces the on-disk paths per AD-14 (`.test-mcp/<suite>/coverage-map.json`, etc.).
- **Unit B (orchestrator/MCP owner):** is not bound by AD-14 or AD-15 (neither names `src/orchestrator/` or `src/mcp/` in `Binds:`, and the Structural Seed only lists `runners/`, `worker/`, `registry/`, `selection/`, `coverage/` as touched). Unit B reasonably concludes their layer is untouched by this epic and leaves `runState`/`lastFailures`/`history`/the MCP schemas exactly as they are.

**The clash:** register two suites on one project. Run suite `unit`, then run suite `e2e`. `orchestrator.recordRun` for `e2e` overwrites `this.history.set(projectId, ...)` — the same map slot `unit`'s run just populated — so `get_status`/`get_run_history`/`get_failure_detail` for `projectId` now return whichever suite ran last, regardless of which suite the caller actually cares about, even though the on-disk `.test-mcp/<suite>/history.json` files are correctly separated underneath. Worse, `this.queues` (the per-project run-serialization gate) means suite `unit` and suite `e2e` cannot even run concurrently today — which happens to *mask* the clobbering as "last write wins" rather than a true race, but is itself an unstated behavior (nothing in AD-15 says suites of one project must serialize against each other, and nothing says they may run in parallel either).

**Recommendation:** AD-15 (or a new AD) must explicitly bind the orchestrator's run-state/failure/history stores and the MCP tool schemas, specifying that every one of these becomes keyed by `(projectId, suiteName)` — not just the coverage/selection modules already named.

---

## Finding 2 (severity: high) — `CoverageDataFile` (the combined-coverage input store) is not one of AD-15's three named types, so it can legally stay project-keyed while `CombinedCoverage` becomes suite-scoped

AD-15's Rule names `CoverageMapFile` (the reverse/selection map, `src/coverage/index.ts`) and `CombinedCoverage` (the *output* type, `src/coverage/combined.ts`) — but never mentions `CoverageDataFile`, the *persisted input* that `combineCoverage()` reads from (`coverageDataPath(projectRoot)` → `.test-mcp/coverage-data.json`, keyed only by `projectId` inside the file, `updateCoverageData(existing, projectId, ...)`).

**Two units, both AD-compliant:**
- **Unit A (reverse-map owner):** relocates `coverageMapPath()` to `.test-mcp/<suite>/coverage-map.json` per AD-14's literal worked example.
- **Unit B (combined-coverage owner):** adds `suiteName` to the `CombinedCoverage` *return* type (satisfying "CombinedCoverage... become suite-scoped" to the letter) but leaves `coverageDataPath()`/`updateCoverageData()`/`loadCoverageData()` untouched, since `CoverageDataFile` isn't in AD-15's enumerated list and AD-9 ("Coverage Build Method... stays the Vitest plugin's internal method only, not generalized by this epic") reads as license to leave this store alone.

**The clash:** suite `unit` (vitest) and suite `e2e` (jest, or a second vitest config) both write into the one shared `.test-mcp/coverage-data.json`. `updateCoverageData` "carries forward" every existing entry not explicitly measured this run (`for (const [testRel, tc] of Object.entries(existing?.tests ?? {})) if (existsTest(testRel)) tests[testRel] = tc;`) — so suite `e2e`'s run silently inherits and re-persists suite `unit`'s per-test coverage entries (and vice versa) as long as the relative test-file paths don't collide, and `combineCoverage()` then `map.merge()`s *all* of them unconditionally into one whole-project total. Suite `e2e`'s reported `CombinedCoverage.total` and `thresholdsMet` (AD-15's own gate) get computed against source files suite `e2e` never exercised and whose thresholds config may not even be `e2e`'s — a false-confidence result of exactly the kind AD-15's "Prevents:" clause exists to stop, produced by two implementers each individually honoring AD-15's literal three-name list.

**Recommendation:** name `CoverageDataFile`/`coverageDataPath()` explicitly in AD-15 (or fold it under "CoverageMapFile" broadened to mean "every coverage-module persisted store").

---

## Finding 3 (severity: medium-high) — AD-14 has no suiteName collision rule, so two auto-detected (or override + auto-detect) suites can silently overwrite each other in the `Record<suiteName, ...>`

AD-14's Rule gives `suites: Record<suiteName, {configPath, plugin}>` and says auto-detect "probes each installed plugin's `detect()`," with the Consistency Conventions row saying the default name is "a plugin-derived name like `unit`/`e2e`." Nothing pins down *which* plugin gets which default name, and a `Record` assigns silently on key collision — no rejection, no warning, no merge rule.

**Two units, both AD-compliant:**
- **Unit A (Vitest plugin author):** reads "a plugin-derived name like `unit`" as literally "vitest's default is `unit`" and hardcodes that in `vitestPlugin`'s registration path.
- **Unit B (Jest plugin author, AD-16):** reads the same convention row and — since AD-16 explicitly says Jest is judged by "the same hermetic-fixture-project pattern as the Vitest plugin's tests," inviting close imitation of Vitest's plugin scaffolding — copies the same default-name convention for a single-suite project, also defaulting to `unit` (a jest-only fixture project has no "e2e" to distinguish from; "unit" is the only example name that applies).

**The clash:** a project with both a `jest.config.js` and a `vitest.config.ts` (e.g. mid-migration from Jest to Vitest, a real and common state) auto-detects both plugins successfully. Both default to suite name `unit`. `register` assigns `suites.unit = {configPath: vitest.config.ts, plugin: "vitest"}` then `suites.unit = {configPath: jest.config.js, plugin: "jest"}` (or the reverse, per whatever order plugins are probed) — the second write silently discards the first plugin's suite entirely, with no error surfaced, exactly the "silently colliding" failure mode AD-14's own `Prevents:` clause names, yet its Rule text supplies no dedupe/rename/reject behavior for a same-name collision.

**Recommendation:** AD-14 needs an explicit collision policy: reject `register` with an actionable error naming both colliding plugins, or force a mandatory disambiguating suffix, rather than leaving `Record` overwrite semantics as the de facto (undocumented) tie-break.

---

## Finding 4 (severity: medium) — `--suite` override vs. auto-detect: additive-merge or exclusive-replace is undecided, and so is processing order

AD-14's Rule: "an explicit `--suite name:plugin:configPath` override exists for when auto-detect fails or picks the wrong plugin — auto-detection is the default path, not the only one." This tells you the override *exists*; it does not say whether passing `--suite` at all (a) *replaces* auto-detection for the whole `register` invocation, (b) *adds one entry* while auto-detect still runs and populates the rest, or (c) auto-detect runs first and `--suite` entries are applied after (last-write-wins on name collision) vs. before (auto-detect could clobber the explicit override).

**Two units, both AD-compliant:**
- **Unit A (CLI owner):** implements `--suite` as "the whole point of the override is that auto-detect picked the wrong plugin for this slot" → when `--suite unit:jest:jest.config.js` is passed, `register` **skips** probing `unit`'s auto-detect resolution entirely and applies the override in its place. Compliant with "for when auto-detect... picks the wrong plugin."
- **Unit B (registry owner):** implements suites as "auto-detection is the default path, not the only one" → literally means auto-detect **always runs first** to populate `suites`, and `--suite` entries are merged in **afterward**, overwriting on name collision. Also compliant.

**The clash:** in Unit A's world, running `register --suite unit:jest:jest.config.js` on a project where auto-detect would *also* find a second, unrelated vitest suite named `e2e` still gets both `unit` (jest, explicit) and `e2e` (vitest, auto) — because "skip auto-detect" was scoped per-slot-name in Unit A's mental model but the code Unit A actually wrote skips the *entire* auto-detect pass (simplest implementation of "override exists for when auto-detect fails"), silently dropping the `e2e` suite the user never asked to suppress. In Unit B's world, nothing is silently dropped, but if auto-detect's `unit` guess happens to run its probe with I/O side effects (e.g., writes a default suite entry to `.test-mcp/` before the override is applied — plausible if suite state is provisioned incrementally rather than atomically), a crash between auto-detect and override-merge leaves a project half-registered with the *wrong* plugin bound to `unit`, which is precisely the failure state the override was invented to prevent. Neither AD-14 nor the CLI section says which of these designs is correct, nor whether the merge is atomic.

**Recommendation:** AD-14 should state explicitly: override entries are per-suiteName-slot only (never suppress unrelated auto-detected suites), and the whole `register` write is atomic (compute the full merged `suites` map in memory, then a single `save()` — which the existing `ProjectRegistry.save()` already does atomically for the whole file, so this is cheap to pin down).

---

## Finding 5 (severity: medium) — no precedence rule when two plugins' `detect()` both return true for the same project

AD-12 defines `detect(projectRoot)` with no specified return-type nuance beyond implied boolean, and no priority field. AD-14 says auto-detect "prob[es] each installed plugin's `detect()`" (plural, unordered). Grounded in the actual pre-Epic-7 code: `resolveVitestConfig` (the near-certain basis for `vitestPlugin.detect()`, since AD-13 mandates a verbatim, zero-behavior-change extraction) matches on **filename presence alone** — including bare `vite.config.ts`/`vite.config.js`, files that may exist purely for a Vite *build*, with no `test:` block at all, in a project that actually runs its tests through Jest (`jest.config.js` + a separate `"jest"` key in `package.json`).

**Two units, both AD-compliant:**
- **Unit A (registry/CLI owner):** iterates installed plugins in the order they're statically imported (Structural Seed lists `vitest/` before `jest/`) → on a project with both a bare `vite.config.ts` and a real `jest.config.js`, Vitest's `detect()` fires first and wins, auto-registering the project's default suite as **vitest** — which will then fail at `run()` time (no `test` files vitest recognizes, or it silently runs zero tests) even though the project's real tests are Jest's.
- **Unit B (someone re-deriving the same registration logic later, e.g. for a `--suite` "auto for this slot" convenience mode, or a different contributor iterating `Object.values(installedPlugins)` from a `Map` whose insertion order came from package.json dependency order):** iterates in a different order (e.g. alphabetical, or dependency-declaration order in the project being registered, where `jest` happens to be listed first) → the identical project on Unit B's code path auto-registers as **jest** instead.

**The clash:** the same repository, registered by two different (both AD-12/13/14-compliant) builds of `test-mcp register`, ends up bound to a different runner plugin for its default suite — a nondeterminism that AD-12 doesn't forbid because it never assigns detect() results a precedence/specificity ranking (e.g., "a plugin whose `detect()` matched a runner-specific config file — `jest.config.js`, `vitest.config.ts` — outranks one that only matched a generic/shared file like `vite.config.ts`").

**Recommendation:** AD-12 should require `detect()` to report a confidence/specificity signal (or AD-14 should define an explicit plugin-priority order), and require content-sniffing (does `vite.config.ts` actually export a `test` block?) rather than filename-only matching, before it's promoted to a multi-plugin auto-detect context — filename-only detection was safe when only one plugin (Vitest) existed to match against.

---

## Finding 6 (severity: low-medium) — nothing forbids two suite entries from resolving to the identical `(plugin, configPath)` pair

AD-14's `Prevents:` clause is about two suites colliding on "one `projectId`/config/coverage-map" — but the Rule itself only forbids *silent* collision on state, not the registration of two differently-named suites that point at the exact same underlying config file (e.g. two `--suite` overrides, `unit:vitest:vitest.config.ts` and `smoke:vitest:vitest.config.ts`, or a Vitest workspace file matched independently by two probing passes). This is legitimate in some cases (splitting one config by test-name pattern isn't crazy) but the spine gives no rule for whether the *same* config being run twice under two suite identities is expected/supported or a mistake to flag — an implementer building the registry validation and an implementer building the CLI's `--suite` parser can each be individually correct and produce a project where two suites' independent `.test-mcp/<suite>/coverage-map.json` trees are both built by literally the same `vitest run` invocation shape, doubling measurement cost with no architectural signal that this is intentional vs. accidental (e.g., a copy-pasted `--suite` line with the wrong configPath).

**Recommendation:** either explicitly permit it (document that plugins are responsible for any filtering needed to make two same-config suites meaningfully different) or have `register` warn/reject when two suite entries share `(plugin, configPath)`.

---

## Summary Table

| # | AD(s) | Two compliant units | Clash |
| --- | --- | --- | --- |
| 1 | AD-15 (Binds gap) | coverage/selection owner vs. orchestrator/MCP owner | `runState`/`lastFailures`/`history` Maps stay `projectId`-only; suite runs clobber each other's status/history; MCP `run_tests` already has a dead `suite` param today |
| 2 | AD-15 (naming gap) | reverse-map owner vs. combined-coverage owner | `CoverageDataFile`/`coverage-data.json` isn't named alongside `CoverageMapFile`/`CombinedCoverage`; stays project-shared, silently blends two suites' per-test coverage |
| 3 | AD-14 (no collision rule) | Vitest plugin author vs. Jest plugin author | both default an auto-detected suite to name `unit`; `Record` overwrite silently drops one suite |
| 4 | AD-14 (override semantics) | CLI owner vs. registry owner | `--suite` read as exclusive-replace vs. additive-merge; also unclear whether the merge is atomic |
| 5 | AD-12/AD-14 (no precedence) | two independent implementations of the auto-detect loop | plugin iteration order decides which runner "wins" a project whose configs are ambiguous (bare `vite.config.ts` + real `jest.config.js`) |
| 6 | AD-14 (no same-config rule) | registry validator vs. CLI `--suite` parser | two suite names can legally point at the identical `(plugin, configPath)` pair with no signal of intent |
