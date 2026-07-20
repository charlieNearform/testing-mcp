import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { ProjectRegistry } from "../src/registry/project-registry.ts";
import { Orchestrator } from "../src/orchestrator/index.ts";

// End-to-end smoke coverage for Epic 8 (Async Execution & Observability) against the REAL
// worker and a REAL vitest process -- unlike test/mcp-run-tests-async.test.ts and
// test/orchestrator-stall-watchdog.test.ts, which use the synthetic blocking-worker fixture for
// deterministic IPC-level timing control. This file exists to catch anything only a real vitest
// process (real config resolution, real IPC message shapes) can surface, and covers two
// behaviors neither of those files exercises at all: get_test_status's runId disambiguation
// between overlapping runs, and the stall watchdog against a genuinely hung real vitest config
// (not a simulated IPC silence). It intentionally does NOT re-test waitMs/project-config-default
// layering, or a fast-inline-result race -- both are already covered deterministically (and much
// faster) via the blocking-worker fixture in test/mcp-run-tests-async.test.ts; duplicating them
// here would only add more real-vitest child-process forks to the full-suite's parallel load for
// no new coverage. Kept to the minimum number of real forks (3 total) needed to prove the two
// genuinely new behaviors: an earlier 4-test/5-fork draft of this file consistently (3/3 runs)
// made test/watch.test.ts's own poll timeout fail under the full suite's parallel load (`git
// blame` that file's poll-timeout comment for its prior history of exactly this failure mode);
// cutting to 3 forks measurably reduced but did not fully eliminate the added risk -- this repo's
// full suite already has some load-sensitive flakiness independent of this file (see
// deferred-work.md). If test/watch.test.ts (or anything else) starts failing more often after
// this file lands, look here first.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "worker", "index.js");
// Dedicated fixtures (not test-fixtures/sample-project) so this file never contends with other
// test files over that shared fixture's on-disk state.
const liveSmokeProject = path.join(repoRoot, "test-fixtures", "live-smoke-project");
const hangingConfigProject = path.join(repoRoot, "test-fixtures", "hanging-config-project");

function textOf(res: unknown): unknown {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
}

async function setup(orchestratorOpts: ConstructorParameters<typeof Orchestrator>[0] = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-e2e-smoke-"));
  const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
  const orchestrator = new Orchestrator({ workerPath, ...orchestratorOpts });
  const server = createMcpServer({ registry, orchestrator, defaultRunWaitMs: 5_000 });
  const client = new Client({ name: "epic-8-e2e-smoke", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  const cleanup = async (): Promise<void> => {
    await client.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { client, registry, cleanup };
}

async function pollStatus(
  client: Client,
  projectId: string,
  runId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - start < timeoutMs) {
    const res = await client.callTool({ name: "get_test_status", arguments: { projectId, runId } });
    last = textOf(res) as Record<string, unknown>;
    if (last.state === "complete" || last.state === "error") return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  return last;
}

describe("Epic 8 live e2e smoke: async run_tests + get_test_status against a real vitest worker", () => {
  it(
    "two overlapping real runs: job handle + AD-21 live shape for the first, queued disambiguation then its own result for the second",
    async () => {
      const { client, registry, cleanup } = await setup();
      try {
        const { projectId } = await registry.register(liveSmokeProject);
        // The fixture test (test-fixtures/live-smoke-project/smoke.test.ts) takes a fixed ~400ms;
        // if that delay ever changes, keep waitMs comfortably below it so both calls still return
        // job handles rather than settling inline.
        const [res1, res2] = await Promise.all([
          client.callTool({ name: "run_tests", arguments: { projectId, waitMs: 20 } }),
          client.callTool({ name: "run_tests", arguments: { projectId, waitMs: 20 } }),
        ]);
        const job1 = textOf(res1) as { runId?: string; projectId?: string; state?: string };
        const job2 = textOf(res2) as { runId?: string; state?: string };
        expect(job1.state).toBe("running");
        expect(job1.projectId).toBe(projectId);
        expect(job1.runId).toBeTruthy();
        expect(job2.runId).toBeTruthy();
        expect(job1.runId).not.toBe(job2.runId);

        // run_tests's own response can't tell queued from actually-executing (both just say
        // "running" once waitMs elapses) -- only get_test_status(runId) can, and per-project runs
        // serialize, so exactly one of these two runIds is the one occupying the slot right now.
        // Determine which dynamically rather than assuming call order maps to dispatch order.
        const status1 = textOf(
          await client.callTool({ name: "get_test_status", arguments: { projectId, runId: job1.runId } }),
        ) as { state?: string; runId?: string; live?: { log?: unknown[]; tests?: unknown[]; lastProgressAt?: number } };
        const status2 = textOf(
          await client.callTool({ name: "get_test_status", arguments: { projectId, runId: job2.runId } }),
        ) as { state?: string; runId?: string };
        const [running, queued, queuedRunId] =
          status1.state === "running" ? [status1, status2, job2.runId] : [status2, status1, job1.runId];
        expect(running.state).toBe("running");
        expect(queued.state).toBe("queued");
        expect(queued.runId).toBe(queuedRunId);

        // The one currently running exposes AD-21's live shape (log, not logTail; tests array;
        // lastProgressAt). At most one test case can be in the list at this early snapshot (its
        // own case-start IPC message may not have arrived yet, so this can legitimately be 0, but
        // never more than the fixture's single test -- guards against either fixture's glob ever
        // accidentally widening and picking up an unintended extra file).
        expect(running.live).toBeDefined();
        expect(Array.isArray(running.live!.log)).toBe(true);
        expect(Array.isArray(running.live!.tests)).toBe(true);
        expect(running.live!.tests!.length).toBeLessThanOrEqual(1);
        expect(typeof running.live!.lastProgressAt).toBe("number");

        // The queued run, once unblocked, eventually completes and reports its OWN result (with
        // exactly the fixture's one test, not more) -- not the other run's. (Deliberately not
        // polling the CURRENTLY-running one to completion here: the instant it settles, the queue
        // immediately promotes the other, overwriting the project's single current-run-state
        // entry -- polling past that point would race the promotion. See deferred-work.md.)
        const finalQueued = await pollStatus(client, projectId, queuedRunId!, 10_000);
        expect(finalQueued.state).toBe("complete");
        expect(finalQueued.runId).toBe(queuedRunId);
        expect((finalQueued.lastResult as { total?: number } | undefined)?.total).toBe(1);
      } finally {
        await cleanup();
      }
    },
    20_000,
  );

  it(
    "the provisional stall watchdog kills a real worker whose vitest config-discovery hangs forever",
    async () => {
      const { client, registry, cleanup } = await setup({ staleTestGraceMs: 1_500 });
      try {
        const { projectId } = await registry.register(hangingConfigProject);
        const t0 = Date.now();
        const res = await client.callTool({ name: "run_tests", arguments: { projectId, waitMs: 200 } });
        const job = textOf(res) as { runId?: string; state?: string };
        expect(job.state).toBe("running");

        const final = await pollStatus(client, projectId, job.runId!, 15_000);
        const elapsedMs = Date.now() - t0;
        expect(final.state).toBe("error");
        expect(String(final.lastError)).toContain("worker stalled");
        expect(String(final.lastError)).toContain("provisional grace");
        // Fires at ~staleTestGraceMs alone (AD-20), not the old default-timeout+grace behavior.
        // 8s is an empirically-chosen margin (observed local runs land well under 2s; this
        // leaves headroom for real vitest/esbuild startup jitter under CI/parallel-suite load,
        // not a measured worst case) -- well inside the 20s test timeout either way.
        expect(elapsedMs).toBeLessThan(8_000);
      } finally {
        await cleanup();
      }
    },
    20_000,
  );
});
