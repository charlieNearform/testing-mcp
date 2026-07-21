import { describe, it, expect } from "vitest";
import { startVitest as realStartVitest } from "vitest/node";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runVitest } from "../src/worker/index.ts";

// Dedicated fixture (not test-fixtures/sample-project) so this file never contends with other
// test files over that shared fixture's on-disk state.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = path.join(repoRoot, "test-fixtures", "pool-retry-project");

const POOL_ERROR = '[vitest-pool]: Failed to start forks worker for test files ["fake.test.ts"]';

type FakeStartVitest = Parameters<typeof runVitest>[5];

/** A fake `startVitest` that throws the real, transient Vitest-pool error for the first
 *  `failCount` calls, then delegates to the REAL `startVitest` (pointed at the fixture via
 *  `root`) so the eventually-successful path exercises a real Vitest run, not a mock result. */
function flakyStartVitest(failCount: number): FakeStartVitest {
  let calls = 0;
  return async (mode, filters, options) => {
    calls++;
    if (calls <= failCount) throw new Error(POOL_ERROR);
    return realStartVitest(mode, filters, { ...options, root: fixture });
  };
}

/** Captures whatever `send()` (inside runOnce) writes to `process.send` -- this test runs
 *  in-process (not a forked child), so `process.send` is normally undefined; stub it. `extraMs`
 *  keeps capturing for a bit after `fn()` resolves, so a test can prove nothing MORE arrives. */
async function withCapturedSends<T>(fn: () => Promise<T>, extraMs = 0): Promise<{ result: T; sent: unknown[] }> {
  const sent: unknown[] = [];
  const original = process.send;
  process.send = ((msg: unknown) => {
    sent.push(msg);
    return true;
  }) as typeof process.send;
  try {
    const result = await fn();
    if (extraMs > 0) await new Promise((resolve) => setTimeout(resolve, extraMs));
    return { result, sent };
  } finally {
    process.send = original;
  }
}

function configMessagesFor(sent: unknown[], runId: string): Array<{ testTimeoutMs?: number }> {
  return sent.filter(
    (m): m is { type: string; runId: string; testTimeoutMs?: number } =>
      typeof m === "object" && m !== null && (m as { type?: unknown }).type === "config" && (m as { runId?: unknown }).runId === runId,
  );
}

describe("runVitest pool-start retry (real project reported: [vitest-pool] Failed to start forks worker)", () => {
  it("retries a transient [vitest-pool] failure and eventually succeeds", async () => {
    // 1 initial attempt + 2 retries = 3 total; failing twice still lands on the 3rd (last allowed).
    const { result } = await runVitest(
      fixture,
      { files: [], changed: false },
      "run-retry-success",
      undefined,
      5000,
      flakyStartVitest(2),
    );
    expect(result.success).toBe(true);
    expect(result.total).toBe(1);
  }, 30_000);

  it("exhausts retries and rejects with the ORIGINAL error message, not a wrapper", async () => {
    await expect(
      runVitest(
        fixture,
        { files: [], changed: false },
        "run-retry-exhausted",
        undefined,
        5000,
        flakyStartVitest(3),
      ),
    ).rejects.toThrow(POOL_ERROR);
  }, 30_000);

  it("does not retry an unrelated startVitest failure", async () => {
    let calls = 0;
    const alwaysThrowsOther: FakeStartVitest = async () => {
      calls++;
      throw new Error("some unrelated real failure");
    };
    await expect(
      runVitest(fixture, { files: [], changed: false }, "run-no-retry", undefined, 5000, alwaysThrowsOther),
    ).rejects.toThrow("some unrelated real failure");
    expect(calls).toBe(1); // no retry attempted
  }, 10_000);

  it("heartbeats via `config` while an attempt is genuinely pending, includes testTimeoutMs, and truly stops once settled", async () => {
    let calls = 0;
    const slowThenSucceed: FakeStartVitest = async (mode, filters, options) => {
      calls++;
      if (calls === 1) {
        // Long enough to observe >=2 heartbeat ticks (4s interval) before it fails.
        await new Promise((resolve) => setTimeout(resolve, 9000));
        throw new Error(POOL_ERROR);
      }
      return realStartVitest(mode, filters, { ...options, root: fixture });
    };
    const { sent } = await withCapturedSends(
      () => runVitest(fixture, { files: [], changed: false }, "run-heartbeat-live", undefined, 5000, slowThenSucceed),
      5000, // keep capturing past one more heartbeat interval after it resolves
    );
    const configMessages = configMessagesFor(sent, "run-heartbeat-live");
    expect(configMessages.length).toBeGreaterThanOrEqual(2);
    expect(configMessages.every((m) => m.testTimeoutMs === 5000)).toBe(true);
    // The heartbeat must never masquerade as `progress` -- that would overwrite displayed
    // completed/total counts with a false 0/0 for a run that may already show real progress.
    expect(sent.some((m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "progress")).toBe(
      false,
    );
  }, 30_000);

  it("still heartbeats (without testTimeoutMs) when testTimeoutMs is unknown -- closes the gap iteration 1 missed", async () => {
    let calls = 0;
    const slowThenSucceed: FakeStartVitest = async (mode, filters, options) => {
      calls++;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 9000));
        throw new Error(POOL_ERROR);
      }
      return realStartVitest(mode, filters, { ...options, root: fixture });
    };
    const { sent } = await withCapturedSends(() =>
      runVitest(
        fixture,
        { files: [], changed: false },
        "run-heartbeat-unknown-timeout",
        undefined,
        undefined, // testTimeoutMs unknown
        slowThenSucceed,
      ),
    );
    const configMessages = configMessagesFor(sent, "run-heartbeat-unknown-timeout");
    expect(configMessages.length).toBeGreaterThanOrEqual(2);
    expect(configMessages.every((m) => m.testTimeoutMs === undefined)).toBe(true);
  }, 30_000);

  it("resets reporter progress state fresh for each retry attempt -- a discarded attempt's partial progress must not leak", async () => {
    const progressCalls: Array<{ completed: number; total: number }> = [];
    let calls = 0;
    const fake: FakeStartVitest = async (mode, filters, options) => {
      calls++;
      const reporter = (options.reporters as Array<{ onTestRunStart: (s: unknown[]) => void; onTestModuleEnd: () => void }>)[0];
      if (calls === 1) {
        // Simulate real progress on the FIRST (doomed) attempt before it fails -- reachable in
        // practice when a LATER file's pool worker fails to start after earlier files already ran.
        reporter.onTestRunStart(new Array(20).fill(0)); // total = 20
        reporter.onTestModuleEnd(); // completed = 1
        reporter.onTestModuleEnd(); // completed = 2
        throw new Error(POOL_ERROR);
      }
      return realStartVitest(mode, filters, { ...options, root: fixture });
    };
    await runVitest(
      fixture,
      { files: [], changed: false },
      "run-fresh-state",
      (completed, total) => progressCalls.push({ completed, total }),
      5000,
      fake,
    );
    // Sanity: the fake did report bogus progress on the discarded attempt.
    expect(progressCalls.some((p) => p.total === 20)).toBe(true);
    // The retried (real, successful) attempt must never report completed > total -- that can only
    // happen if `completed` carried over from the discarded attempt's stale closure.
    expect(progressCalls.some((p) => p.completed > p.total)).toBe(false);
  }, 30_000);
});
