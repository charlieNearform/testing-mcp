import { defineConfig } from "vitest/config";

// The async config function never resolves -- simulates a hang in the worker's own
// createVitest() config-discovery step (src/worker/index.ts's readResolvedRunConfig), before any
// test can run and before any config/case-start/case-result/phase-progress message can possibly
// be sent (the worker's initial "ready" IPC message still fires immediately on fork, unaffected
// by this hang -- it's sent before config discovery is ever attempted). This is the exact failure
// class the provisional stall watchdog (AD-20) exists to catch: a hang the worker cannot
// self-report via any of the progress-bearing message types, since it happens before any of them
// can be sent.
export default defineConfig(async () => {
  await new Promise(() => {});
  return { test: { include: ["*.test.ts"] } };
});
