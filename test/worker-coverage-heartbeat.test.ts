import { afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAndPersistCoverageMap } from "../src/worker/index.ts";

// Dedicated, per-test mkdtemp dirs (not a shared fixture) so buildAndPersistCoverageMap's real
// filesystem side effects (.test-mcp/coverage-map.json, coverage-data.json) never leak state
// between these tests or contend with other test files. Created under test-fixtures/ (not
// os.tmpdir()) purely so `require("vitest/node")` inside buildAndPersistCoverageMap resolves via
// the normal upward node_modules walk to this repo's own install -- these tests never exercise a
// real Vitest run (every startVitest call is faked), so nothing else about the project matters.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tmpDirs: string[] = [];

function makeCwd(): string {
  const dir = fs.mkdtempSync(path.join(repoRoot, "test-fixtures", "coverage-heartbeat-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type FakeStartVitest = Parameters<typeof buildAndPersistCoverageMap>[5];

const fakeVitestInstance = { close: async () => {}, config: { isolate: false } };

function isPhaseProgress(
  m: unknown,
): m is { type: "phase-progress"; runId: string; completed: number; total: number } {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "phase-progress";
}

/** Captures whatever `send()` writes to `process.send` -- these run in-process (not a forked
 *  child), so `process.send` is normally undefined; stub it, matching worker-pool-retry.test.ts. */
function captureSends(): { sent: unknown[]; restore: () => void } {
  const sent: unknown[] = [];
  const original = process.send;
  process.send = ((msg: unknown) => {
    sent.push(msg);
    return true;
  }) as typeof process.send;
  return {
    sent,
    restore: () => {
      process.send = original;
    },
  };
}

describe("coverage-measurement phase heartbeats (stall watchdog fix)", () => {
  it("heartbeats (unchanged completed count) while a single file's measurement is slow, then sends the real completion", async () => {
    vi.useFakeTimers();
    const { sent, restore } = captureSends();
    try {
      // Discriminate by WHICH file is being measured (the baseline's own synthetic filename),
      // never by call order -- an unenforced "1st call = baseline" assumption would silently test
      // the wrong phase if that ordering ever changed.
      const fakeStartVitest: FakeStartVitest = async (_mode, filters) => {
        const isBaseline = filters.some((f) => f.includes("__test-mcp-baseline__"));
        if (isBaseline) return fakeVitestInstance; // setup-baseline measurement -- resolves fast
        // The real per-file measurement -- long enough to observe >=2 heartbeat ticks (4s interval).
        await new Promise((resolve) => setTimeout(resolve, 9000));
        return fakeVitestInstance;
      };
      const cwd = makeCwd();
      const promise = buildAndPersistCoverageMap(
        cwd,
        "proj",
        ["a.test.ts"],
        "run-file-heartbeat",
        undefined,
        fakeStartVitest,
      );
      await vi.advanceTimersByTimeAsync(9000);
      await promise;

      const progress = sent.filter(isPhaseProgress);
      const zeroCompleted = progress.filter((m) => m.completed === 0);
      const oneCompleted = progress.filter((m) => m.completed === 1);
      // 1 immediate heartbeat for the baseline + >=2 immediate/interval heartbeats for the slow file.
      expect(zeroCompleted.length).toBeGreaterThanOrEqual(3);
      // The real completion signal (unaffected by this change) still fires exactly once.
      expect(oneCompleted.length).toBe(1);
      expect(oneCompleted[0]?.total).toBe(1);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("a heartbeat send() failure is swallowed, not thrown", async () => {
    vi.useFakeTimers();
    let sendCalls = 0;
    const original = process.send;
    process.send = (() => {
      sendCalls++;
      throw new Error("IPC channel torn down");
    }) as typeof process.send;
    try {
      // Delays EVERY call (baseline AND the per-file measurement both use this same fake) --
      // advance enough fake time below to cover both sequential 9000ms waits, not just one.
      const fakeStartVitest: FakeStartVitest = async () => {
        await new Promise((resolve) => setTimeout(resolve, 9000)); // long enough for >=1 heartbeat tick
        return fakeVitestInstance;
      };
      const cwd = makeCwd();
      const promise = buildAndPersistCoverageMap(
        cwd,
        "proj",
        ["a.test.ts"],
        "run-send-fails",
        undefined,
        fakeStartVitest,
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(promise).resolves.toBeDefined();
    } finally {
      process.send = original;
      vi.useRealTimers();
    }
    expect(sendCalls).toBeGreaterThan(0); // sanity: the throwing send() was actually exercised
  });

  it("stops heartbeating once the budget-aware max heartbeat duration elapses on a never-resolving call", async () => {
    vi.useFakeTimers();
    const { sent, restore } = captureSends();
    try {
      const neverResolvingStartVitest: FakeStartVitest = () => new Promise(() => {}); // never settles
      const cwd = makeCwd();
      // Intentionally not awaited: this fake never resolves by design (that's what's under test),
      // so there is nothing to await and no cancellation path to invoke (matches the worker's own
      // unimplemented "cancel"). The resulting pending promise is bounded to this test file's own
      // process lifetime, not a growing leak across runs.
      void buildAndPersistCoverageMap(
        cwd,
        "proj",
        ["a.test.ts"],
        "run-cap-test",
        undefined,
        neverResolvingStartVitest,
      );
      // Default budgetMs (120_000) + interval (4000) = 124_000, floored at COVERAGE_HEARTBEAT_MAX_MS
      // (130_000) -- advance past whichever is larger.
      await vi.advanceTimersByTimeAsync(130_000 + 10_000);
      const countAtCap = sent.filter(isPhaseProgress).length;
      expect(countAtCap).toBeGreaterThan(0); // heartbeats DID fire before the cap
      await vi.advanceTimersByTimeAsync(20_000); // well past another would-be interval tick
      expect(sent.filter(isPhaseProgress).length).toBe(countAtCap); // but no more after the cap
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("the heartbeat cap rises with a raised TEST_MCP_MEASURE_BUDGET_MS instead of staying fixed at the default floor", async () => {
    vi.useFakeTimers();
    const original = process.env.TEST_MCP_MEASURE_BUDGET_MS;
    process.env.TEST_MCP_MEASURE_BUDGET_MS = "300000"; // well above the 130_000 default floor
    const { sent, restore } = captureSends();
    try {
      const neverResolvingStartVitest: FakeStartVitest = () => new Promise(() => {});
      const cwd = makeCwd();
      void buildAndPersistCoverageMap(
        cwd,
        "proj",
        ["a.test.ts"],
        "run-raised-budget",
        undefined,
        neverResolvingStartVitest,
      );
      // Well past the OLD fixed 130_000 cap, but still inside the new budget-derived one
      // (300_000 + 4000) -- heartbeats must still be arriving here.
      await vi.advanceTimersByTimeAsync(200_000);
      const countBeforeNewCap = sent.filter(isPhaseProgress).length;
      expect(countBeforeNewCap).toBeGreaterThan(0);
      // Now advance well past the raised cap too -- heartbeats must stop.
      await vi.advanceTimersByTimeAsync(150_000);
      const countAfter = sent.filter(isPhaseProgress).length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sent.filter(isPhaseProgress).length).toBe(countAfter);
      expect(countAfter).toBeGreaterThan(countBeforeNewCap); // it kept heartbeating in between
    } finally {
      restore();
      vi.useRealTimers();
      if (original === undefined) delete process.env.TEST_MCP_MEASURE_BUDGET_MS;
      else process.env.TEST_MCP_MEASURE_BUDGET_MS = original;
    }
  });

  // The files=[] (native full-suite) case is covered by the "native full-suite coverage pass
  // heartbeats" describe block below -- every test there also passes only startVitestOverride.
  it("does not throw when only startVitestOverride is provided for an explicit-files (selective) call", async () => {
    vi.useFakeTimers();
    try {
      const cwd = makeCwd();
      const promise = buildAndPersistCoverageMap(
        cwd,
        "proj",
        ["a.test.ts"],
        "run-legit-single-override",
        undefined,
        async () => fakeVitestInstance,
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Story 3.7: a full-suite call (`files: []` -- this also covers the "changed-only" fallback
// strategy, which also carries `files: []`; see the story's Dev Notes) is a single native Vitest
// pass, not per-file discovery-and-measurement. It gets its OWN heartbeat ceiling
// (TEST_MCP_FULL_COVERAGE_BUDGET_MS / a 30-minute floor), sized for a whole-suite run rather than
// one file, since the per-file TEST_MCP_MEASURE_BUDGET_MS-derived ceiling would cut heartbeats off
// long before a real multi-minute full-suite pass finishes.
describe("native full-suite coverage pass heartbeats (Story 3.7)", () => {
  it("heartbeats (completed:0, total:0) while the native full-suite pass itself is slow, with no discovery step beforehand", async () => {
    vi.useFakeTimers();
    const { sent, restore } = captureSends();
    try {
      const fakeStartVitest: FakeStartVitest = async () => {
        await new Promise((resolve) => setTimeout(resolve, 9000));
        return fakeVitestInstance;
      };
      const cwd = makeCwd();
      const promise = buildAndPersistCoverageMap(
        cwd,
        "proj",
        [], // files=[] -> native full-suite pass, not discovery
        "run-native-full-heartbeat",
        undefined,
        fakeStartVitest,
      );
      await vi.advanceTimersByTimeAsync(9000);
      await promise;

      const progress = sent.filter(isPhaseProgress).filter((m) => m.runId === "run-native-full-heartbeat");
      expect(progress.length).toBeGreaterThanOrEqual(3); // 1 immediate + >=2 interval ticks
      expect(progress.every((m) => m.completed === 0 && m.total === 0)).toBe(true);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("stops heartbeating once the native pass's own (much larger) budget-aware max elapses on a never-resolving call", async () => {
    vi.useFakeTimers();
    const { sent, restore } = captureSends();
    try {
      const neverResolvingStartVitest: FakeStartVitest = () => new Promise(() => {});
      const cwd = makeCwd();
      void buildAndPersistCoverageMap(
        cwd,
        "proj",
        [],
        "run-native-cap-test",
        undefined,
        neverResolvingStartVitest,
      );
      // The per-file 130_000 default floor must NOT apply here -- advance past it and confirm
      // heartbeats are still arriving, because the native pass uses its own 30-minute floor.
      await vi.advanceTimersByTimeAsync(130_000 + 10_000);
      const countPastFileCap = sent.filter(isPhaseProgress).length;
      expect(countPastFileCap).toBeGreaterThan(0);
      // Now advance past the native pass's own 30-minute floor -- heartbeats must stop.
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 10_000);
      const countAtNativeCap = sent.filter(isPhaseProgress).length;
      expect(countAtNativeCap).toBeGreaterThan(countPastFileCap); // kept heartbeating in between
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sent.filter(isPhaseProgress).length).toBe(countAtNativeCap); // but no more after the cap
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("the native pass's heartbeat cap rises with TEST_MCP_FULL_COVERAGE_BUDGET_MS instead of staying fixed at the 30-minute floor", async () => {
    vi.useFakeTimers();
    const original = process.env.TEST_MCP_FULL_COVERAGE_BUDGET_MS;
    process.env.TEST_MCP_FULL_COVERAGE_BUDGET_MS = String(60 * 60_000); // well above the 30-min floor
    const { sent, restore } = captureSends();
    try {
      const neverResolvingStartVitest: FakeStartVitest = () => new Promise(() => {});
      const cwd = makeCwd();
      void buildAndPersistCoverageMap(
        cwd,
        "proj",
        [],
        "run-native-raised-budget",
        undefined,
        neverResolvingStartVitest,
      );
      await vi.advanceTimersByTimeAsync(45 * 60_000); // past the 30-min floor, inside the raised 60-min cap
      const countBeforeNewCap = sent.filter(isPhaseProgress).length;
      expect(countBeforeNewCap).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(20 * 60_000); // now past the raised cap too
      const countAfter = sent.filter(isPhaseProgress).length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sent.filter(isPhaseProgress).length).toBe(countAfter);
      expect(countAfter).toBeGreaterThan(countBeforeNewCap);
    } finally {
      restore();
      vi.useRealTimers();
      if (original === undefined) delete process.env.TEST_MCP_FULL_COVERAGE_BUDGET_MS;
      else process.env.TEST_MCP_FULL_COVERAGE_BUDGET_MS = original;
    }
  });

  // Story 3.7 Task 6.1/6.7: the story explicitly requires "exactly one startVitest coverage
  // call" -- assert the literal call count, not just the observable shape of the result.
  it("calls startVitest exactly once for a full-suite (files=[]) coverage request, never per-file", async () => {
    let calls = 0;
    const countingStartVitest: FakeStartVitest = async () => {
      calls++;
      return fakeVitestInstance;
    };
    const cwd = makeCwd();
    await buildAndPersistCoverageMap(
      cwd,
      "proj",
      [],
      "run-native-call-count",
      undefined,
      countingStartVitest,
    );
    expect(calls).toBe(1);
  });
});
