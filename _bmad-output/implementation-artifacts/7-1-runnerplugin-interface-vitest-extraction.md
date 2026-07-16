# Story 7.1: RunnerPlugin Interface & Vitest Extraction (Zero Behavior Change)

**ID:** `7-1`
**Slice:** `src/runners` (NEW), `src/worker`
**Type:** `refactor` (behavior-preserving extraction)
**Depends on:** none (first story of Epic 7)
**Status:** ready-for-dev

## Source

test-server-mcp's daemon currently hardcodes Vitest: `src/worker/index.ts` resolves
`vitest/node` directly via `projectRequire` at two sites and calls `startVitest`/`createVitest`
throughout. This story extracts all of that behind a `RunnerPlugin` interface so Vitest becomes
the first of several possible runners instead of a hardcoded assumption — with **zero behavior
change**. This is the foundation Epic 7's later stories (multi-suite registry, per-suite scoping,
Jest plugin) build on.

- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md`,
  AD-12 (RunnerPlugin Interface) and AD-13 (Zero-Behavior-Change Vitest Extraction) — read both in full before starting.
- Current code (read in full before starting): `src/worker/index.ts` (663 lines, all of it relevant —
  this story moves most of it).

## Acceptance criteria

**Given** the current `worker/index.ts` implementation
**When** the extraction is complete
**Then** `src/runners/types.ts` exports the `RunnerPlugin` interface (AD-12) and `src/runners/vitest/index.ts`
exports a `vitestPlugin: RunnerPlugin` object implementing it; `worker/index.ts` no longer contains
a `projectRequire("vitest/node")` call anywhere.

**Given** the existing test suite (`test/worker-run.test.ts`, `test/worker-result.test.ts`,
`test/coverage-build.test.ts`, `test/isolation.test.ts`, and any other test exercising worker
behavior)
**When** it runs against the extracted code
**Then** it passes unmodified (no test file edits) — same reporter callbacks, same options passed
to Vitest, same `coverage-final.json` handling, same selection/union/full-suite-fallback behavior.

**Given** a call to any `RunnerPlugin` method other than `detect`
**When** it is invoked from `worker/index.ts`
**Then** it receives an explicit `configPath` parameter (even though this story always passes
`undefined` for it — no suite model exists yet; Story 7.2 will start passing a real value).

## Out of scope

- Multi-suite registry model, `test-mcp register` changes, `--suite` CLI flag (Story 7.2).
- Per-suite scoping of selection/coverage/confidence/orchestrator/MCP surface (Stories 7.3/7.4).
- The Jest plugin (Stories 7.5/7.6).
- Any change to `mapModulesToResult`'s or `mapFailureDetails`'s actual logic — they move, they
  don't change.
- Making `configPath` actually affect which Vitest config is loaded — that requires Story 7.2's
  suite model to exist first (see Escalation triggers below for the open question this raises).

## Notes for the agent

**Step 1 — create the interface.** New file `src/runners/types.ts`:

```ts
export interface RunnerPluginCapabilities {
  coverage: "none" | "summary" | "line-hit";
  changedFileDetection: boolean;
  watch: boolean;
}

export interface RunOpts {
  changed: boolean;
  coverage?: boolean;
}

export interface RunResult {
  result: TestResult;
  failureDetails: FailureDetail[];
}

export interface RunnerPlugin {
  name: string;
  detect(projectRoot: string): boolean;
  capabilities: RunnerPluginCapabilities;
  listTestFiles(projectRoot: string, configPath: string | undefined): Promise<string[]>;
  run(
    projectRoot: string,
    configPath: string | undefined,
    testFiles: string[],
    opts: RunOpts,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<RunResult>;
  affectedTests?(
    projectRoot: string,
    configPath: string | undefined,
    changedFiles: string[],
  ): Promise<string[] | null>;
  readCoverageThresholds?(projectRoot: string, configPath: string | undefined): Promise<unknown>;
  measureCoverage?(
    projectRoot: string,
    configPath: string | undefined,
    absTestFile: string,
  ): Promise<FileMeasurement>;
}
```

Import `TestResult`/`FailureDetail` from `../types/contracts.js`, `FileMeasurement` from
`../coverage/index.js`. `measureCoverage` is on the interface (not just `run`) because
`buildAndPersistCoverageMap` in `worker/index.ts` needs to measure ONE test file's coverage in
isolation — this is a distinct capability from running an arbitrary set of test files, so give it
its own method rather than overloading `run`.

**Step 2 — move code into the Vitest plugin.** New file `src/runners/vitest/index.ts`. Move
VERBATIM (cut, don't rewrite) from `worker/index.ts`:
- All the structural types: `VError`, `VTestResult`, `VTestCase`, `VTestModule`, `VitestInstance`,
  `DiscoveryInstance`, `VitestNode`, `RunOnceResult`.
- `runOnce`, `mapModulesToResult` (keep exported — `test/worker-result.test.ts` imports it),
  `buildSummary`, `mapFailureDetails` (keep exported — tests import it), `MAX_TEST_ENTRIES`.
- `runVitest`, `measureSetupBaseline`, `measureCoverage`, `discoverTestFiles`,
  `readCoverageThresholds`, `withTimeout`.

Every one of these functions currently takes a resolved `startVitest`/`createVitest` as its first
parameter or closes over one — keep that internal wiring exactly as-is; only the OUTER entry
points change shape. At the bottom of the file, export:

```ts
function resolveVitestNode(cwd: string): VitestNode {
  const projectRequire = createRequire(path.join(cwd, "__test-mcp-resolve__.js"));
  return projectRequire("vitest/node") as VitestNode;
}

export const vitestPlugin: RunnerPlugin = {
  name: "vitest",
  detect(projectRoot) {
    // same VITEST_CONFIG_NAMES-style scan resolveVitestConfig already does in src/registry —
    // do NOT duplicate that logic; import and reuse it (see Escalation triggers).
  },
  capabilities: { coverage: "line-hit", changedFileDetection: true, watch: true },
  async listTestFiles(projectRoot, _configPath) {
    const { createVitest } = resolveVitestNode(projectRoot);
    return discoverTestFiles(createVitest);
  },
  async run(projectRoot, _configPath, testFiles, opts, onProgress) {
    const { startVitest } = resolveVitestNode(projectRoot);
    return runVitest(projectRoot, { files: testFiles, changed: opts.changed }, onProgress);
    // NOTE: runVitest currently resolves startVitest ITSELF via createRequire internally today;
    // when moved, decide whether it takes startVitest as a parameter (preferred — matches every
    // other function in this file) or re-resolves internally. Prefer parameterizing for
    // consistency and testability; update its signature accordingly and update call sites.
  },
  async measureCoverage(projectRoot, _configPath, absTestFile) {
    const { startVitest } = resolveVitestNode(projectRoot);
    return measureCoverage(startVitest, projectRoot, absTestFile);
  },
  async readCoverageThresholds(projectRoot, _configPath) {
    const { createVitest } = resolveVitestNode(projectRoot);
    return readCoverageThresholds(createVitest);
  },
};
```

The pseudocode above is illustrative, not copy-paste-exact — `runVitest`'s real current signature
is `runVitest(cwd, opts, onProgress)` and already does its own `projectRequire` internally (see
current `worker/index.ts:307-308`); decide the cleanest parameterization (recommend: make
`runVitest` take `startVitest` as its first argument like `runOnce`/`measureCoverage` already do,
for consistency, and have `resolveVitestNode` be the ONE place per plugin call that resolves the
package) and wire `vitestPlugin.run` accordingly. Whatever shape you choose, the acceptance bar is
behavioral: existing tests pass unmodified.

**Step 3 — thin `worker/index.ts` down to a dispatch shell.** It keeps: `handleRun`,
`buildAndPersistCoverageMap`, `persistAndCombine`, the IPC wiring (`send`, the `process.on("message")`
handler). Replace its direct `projectRequire("vitest/node")` calls and direct
`runVitest`/`measureCoverage`/`discoverTestFiles`/`readCoverageThresholds` calls with calls through
`vitestPlugin` (imported directly for now — `import { vitestPlugin } from "../runners/vitest/index.js"`;
Story 7.2 replaces this direct import with a registry lookup). Pass `configPath: undefined`
everywhere for this story.

**Step 4 — `detect()` reuse.** `src/registry/project-registry.ts` already has `resolveVitestConfig()`
(scans a fixed `VITEST_CONFIG_NAMES` list). `vitestPlugin.detect()` should reuse this exact logic
(import and call it, or extract the shared list/scan into somewhere both can import from) — do NOT
write a second, subtly-different config-detection implementation. If extracting requires moving
`VITEST_CONFIG_NAMES`/the scan function out of `project-registry.ts`, that's fine — it's a pure
move, registry behavior must not change.

**Files changed:** `src/runners/types.ts` (NEW), `src/runners/vitest/index.ts` (NEW),
`src/worker/index.ts` (thinned, no Vitest-specific code remains). No test file should need editing
— if one does, that's a signal the extraction changed behavior, not just location.

## Escalation triggers

- If `runVitest`'s union/full-suite-fallback logic (the `opts.changed && opts.files.length > 0`
  branch at current `worker/index.ts:320-356`) cannot be cleanly parameterized without changing its
  behavior, STOP and describe the specific obstacle rather than reshaping the logic to fit — this
  story is an extraction, not a redesign.
- **`configPath` enforcement is intentionally incomplete in this story.** Vitest's programmatic
  `startVitest`/`createVitest` accept an options object whose exact config-path-override key
  (if one exists distinct from cwd-based discovery) is NOT confirmed in this story or the
  architecture spine. Do not guess an option name. For Story 7.1, `configPath` may be accepted but
  unused (cwd-based discovery remains the actual mechanism, matching today's behavior exactly —
  that IS zero-behavior-change). Leave a comment noting Story 7.2 must confirm and wire the real
  option before multi-suite (same-plugin, different-config) actually works. Do not silently pretend
  this is already solved.

## Auto Run Result

_(to be filled in by the dev-story workflow)_
