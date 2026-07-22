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
// real Vitest run (every startVitest/createVitest call is faked), so nothing else about the
// project matters.
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
type FakeCreateVitest = Parameters<typeof buildAndPersistCoverageMap>[6];

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

  it("heartbeats (completed:0, total:0) while file discovery itself is slow, and the baseline heartbeat right after correctly reports the just-discovered total (not the raw files=[] length)", async () => {
    vi.useFakeTimers();
    const { sent, restore } = captureSends();
    try {
      const fakeCreateVitest: FakeCreateVitest = async () => ({
        close: async () => {},
        globTestSpecifications: async () => {
          await new Promise((resolve) => setTimeout(resolve, 9000));
          return [{ moduleId: "/proj/discovered.test.ts" }];
        },
      });
      const cwd = makeCwd();
      const promise = buildAndPersistCoverageMap(
        cwd,
        "proj",
        [], // files=[] -> discovery runs
        "run-discovery-heartbeat",
        undefined,
        async () => fakeVitestInstance, // baseline + per-file measurement, resolve fast
        fakeCreateVitest,
      );
      await vi.advanceTimersByTimeAsync(9000);
      await promise;

      const progress = sent.filter(isPhaseProgress).filter((m) => m.runId === "run-discovery-heartbeat");
      expect(progress.filter((m) => m.completed === 0 && m.total === 0).length).toBeGreaterThanOrEqual(2);
      // Bad_spec fix: the baseline heartbeat must use the just-discovered real count (1), never the
      // raw `files` parameter (always 0 in discovery mode) -- previously always read 0 here.
      expect(progress.some((m) => m.completed === 0 && m.total === 1)).toBe(true);
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
      const neverResolvingCreateVitest: FakeCreateVitest = () => new Promise(() => {}); // never settles
      const cwd = makeCwd();
      // Intentionally not awaited: this fake never resolves by design (that's what's under test),
      // so there is nothing to await and no cancellation path to invoke (matches the worker's own
      // unimplemented "cancel"). The resulting pending promise is bounded to this test file's own
      // process lifetime, not a growing leak across runs.
      void buildAndPersistCoverageMap(
        cwd,
        "proj",
        [],
        "run-cap-test",
        undefined,
        async () => fakeVitestInstance,
        neverResolvingCreateVitest,
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
      const neverResolvingCreateVitest: FakeCreateVitest = () => new Promise(() => {});
      const cwd = makeCwd();
      void buildAndPersistCoverageMap(
        cwd,
        "proj",
        [],
        "run-raised-budget",
        undefined,
        async () => fakeVitestInstance,
        neverResolvingCreateVitest,
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

  it("throws immediately if files=[] (discovery will run) but only startVitestOverride is provided", async () => {
    const cwd = makeCwd();
    await expect(
      buildAndPersistCoverageMap(
        cwd,
        "proj",
        [], // discovery WILL run and needs createVitestOverride too
        "run-mismatched-override-discovery",
        undefined,
        async () => fakeVitestInstance,
      ),
    ).rejects.toThrow(/createVitestOverride must also be provided/);
  });

  it("throws immediately if only createVitestOverride is provided (setup-baseline always needs startVitest)", async () => {
    const cwd = makeCwd();
    await expect(
      buildAndPersistCoverageMap(
        cwd,
        "proj",
        ["a.test.ts"],
        "run-mismatched-override-baseline",
        undefined,
        undefined,
        async () => ({ close: async () => {}, globTestSpecifications: async () => [] }),
      ),
    ).rejects.toThrow(/startVitestOverride must also be provided/);
  });

  it("does NOT throw when only startVitestOverride is provided and files is non-empty (discovery never runs, so createVitestOverride is genuinely unneeded)", async () => {
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
