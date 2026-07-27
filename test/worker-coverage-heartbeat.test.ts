import { describe, it, expect, vi } from "vitest";
import { withCoverageTailHeartbeat } from "../src/worker/index.ts";

/**
 * Patch B (Story 3.8 review): the coverage-generation tail after the last test module ends is a
 * silent window (V8 collection + istanbul remap + coverage-final.json write) with no test-progress
 * signal, which can exceed the orchestrator's stall watchdog (~10s default). `withCoverageTailHeartbeat`
 * rearms the watchdog with `config` IPC heartbeats while that coverage `runOnce` is pending.
 *
 * Deterministic with fake timers (mirrors the deleted `worker-coverage-heartbeat.test.ts` pattern):
 * these run in-process (not a forked child), so `process.send` is normally undefined -- stub it to
 * capture what `send()` writes.
 */

interface ConfigMsg {
  type: "config";
  runId: string;
  testTimeoutMs?: number;
}
function isConfig(m: unknown): m is ConfigMsg {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "config";
}

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

describe("withCoverageTailHeartbeat (coverage-tail stall-watchdog fix, Patch B)", () => {
  it("rearms the watchdog with `config` heartbeats while the coverage runOnce is pending", async () => {
    vi.useFakeTimers();
    const { sent, restore } = captureSends();
    try {
      const promise = withCoverageTailHeartbeat(
        "run-cov",
        5000,
        () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 12_000)),
      );
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(promise).resolves.toBe("done");

      const configs = sent.filter(isConfig).filter((m) => m.runId === "run-cov");
      // 12s pending / 4s interval -> at least 2 ticks fired during the otherwise-silent tail.
      expect(configs.length).toBeGreaterThanOrEqual(2);
      expect(configs[0]?.testTimeoutMs).toBe(5000);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("omits testTimeoutMs from the heartbeat when it is unknown", async () => {
    vi.useFakeTimers();
    const { sent, restore } = captureSends();
    try {
      const promise = withCoverageTailHeartbeat(
        "run-cov-unknown",
        undefined,
        () => new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      );
      await vi.advanceTimersByTimeAsync(5000);
      await promise;

      const configs = sent.filter(isConfig).filter((m) => m.runId === "run-cov-unknown");
      expect(configs.length).toBeGreaterThanOrEqual(1);
      expect(configs[0]).not.toHaveProperty("testTimeoutMs");
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("swallows a heartbeat send() failure instead of crashing the worker", async () => {
    vi.useFakeTimers();
    const original = process.send;
    process.send = (() => {
      throw new Error("IPC channel torn down");
    }) as typeof process.send;
    try {
      const promise = withCoverageTailHeartbeat(
        "run-cov-send-fails",
        5000,
        () => new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      );
      await vi.advanceTimersByTimeAsync(8000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      process.send = original;
      vi.useRealTimers();
    }
  });

  it("clears the interval once the wrapped call settles (no further heartbeats)", async () => {
    vi.useFakeTimers();
    const { sent, restore } = captureSends();
    try {
      const promise = withCoverageTailHeartbeat(
        "run-cov-clear",
        5000,
        () => new Promise<void>((resolve) => setTimeout(resolve, 6000)),
      );
      await vi.advanceTimersByTimeAsync(6000);
      await promise;

      const before = sent.filter(isConfig).length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent.filter(isConfig).length).toBe(before);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });
});
