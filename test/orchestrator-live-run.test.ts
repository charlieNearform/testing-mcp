import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator/index.ts";

const workerPath = fileURLToPath(
  new URL("../test-fixtures/blocking-worker/worker.mjs", import.meta.url),
);

let roots: string[] = [];

afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

function mkroot(prefix: string): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(r);
  return r;
}

async function waitForStarted(stateDir: string): Promise<void> {
  const startedPath = path.join(stateDir, "started");
  for (let i = 0; i < 200 && !fs.existsSync(startedPath); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(fs.existsSync(startedPath)).toBe(true);
}

/** Poll until the fixture's live-state for `projectId` reflects `runId` (avoids stale-file races
 *  when a stateDir is reused across two sequential runs within one test). */
async function waitForLiveRunId(
  orch: Orchestrator,
  projectId: string,
  runId: string,
): Promise<void> {
  for (let i = 0; i < 200 && orch.getLiveRun(projectId)?.runId !== runId; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(orch.getLiveRun(projectId)?.runId).toBe(runId);
}

/** Write a sentinel-trigger file and wait until the fixture has consumed (deleted) it, so a
 *  tight loop of writes to the SAME filename never races the fixture's own read+delete. */
async function sendAndWaitConsumed(filePath: string, content: string): Promise<void> {
  fs.writeFileSync(filePath, content);
  for (let i = 0; i < 500 && fs.existsSync(filePath); i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(fs.existsSync(filePath)).toBe(false);
}

function sendCaseResult(stateDir: string, file: string, name: string, status: string): void {
  fs.writeFileSync(path.join(stateDir, "send-case-result"), JSON.stringify({ file, name, status }));
}

async function sendCaseResultAndWait(
  stateDir: string,
  file: string,
  name: string,
  status: string,
): Promise<void> {
  await sendAndWaitConsumed(
    path.join(stateDir, "send-case-result"),
    JSON.stringify({ file, name, status }),
  );
}

describe("Orchestrator live run state (Story 8.5)", () => {
  it("populates the live test list from case-start/case-result and returns undefined before any run", () => {
    const root = mkroot("test-mcp-live-none-");
    const orch = new Orchestrator({ workerPath });
    expect(orch.getLiveRun("p")).toBeUndefined();
    void root;
  });

  it("test list is a ring bounded at MAX_LIVE_TEST_ENTRIES, evicting oldest, not freezing", async () => {
    const root = mkroot("test-mcp-live-ring-");
    const stateDir = path.join(root, ".test-mcp");
    const orch = new Orchestrator({ workerPath });
    const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
    await waitForStarted(stateDir);

    // Just over the 2000-entry cap -- each write waits for the fixture to consume it before the
    // next, so no write races the fixture's read+delete of the same sentinel file.
    const TOTAL = 2005;
    for (let i = 0; i < TOTAL; i++) {
      await sendCaseResultAndWait(stateDir, "a.test.ts", `t${i}`, "passed");
    }

    const live = orch.getLiveRun("p");
    expect(live).toBeDefined();
    expect(live!.tests.length).toBeLessThanOrEqual(2000);
    expect(live!.testsTruncated).toBe(true);
    // The oldest entries (t0, t1, ...) were evicted; the most recent ones survive.
    expect(live!.tests.some((t) => t.name === `t${TOTAL - 1}`)).toBe(true);
    expect(live!.tests.some((t) => t.name === "t0")).toBe(false);

    fs.writeFileSync(path.join(stateDir, "release"), "");
    await pending;
  }, 30_000);

  it("log ring captures real stdout content and bounds at 1000 lines", async () => {
    const root = mkroot("test-mcp-live-log-");
    const stateDir = path.join(root, ".test-mcp");
    const orch = new Orchestrator({ workerPath });
    const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
    await waitForStarted(stateDir);

    const TOTAL = 1005;
    for (let i = 0; i < TOTAL; i++) {
      await sendAndWaitConsumed(path.join(stateDir, "send-stdout"), `line-${i}`);
    }

    const live = orch.getLiveRun("p");
    expect(live).toBeDefined();
    expect(live!.logTail.length).toBeLessThanOrEqual(1000);
    expect(live!.logTail.some((l) => l.text === `line-${TOTAL - 1}` && l.stream === "stdout")).toBe(true);
    expect(live!.logTail.some((l) => l.text === "line-0")).toBe(false); // oldest evicted

    fs.writeFileSync(path.join(stateDir, "release"), "");
    await pending;
  }, 30_000);

  it("two concurrent different-project runs don't cross-contaminate each other's live state", async () => {
    const rootA = mkroot("test-mcp-live-a-");
    const rootB = mkroot("test-mcp-live-b-");
    const stateDirA = path.join(rootA, ".test-mcp");
    const stateDirB = path.join(rootB, ".test-mcp");
    const orch = new Orchestrator({ workerPath, maxConcurrentWorkers: 2 });

    const pendingA = orch.runTests({ projectId: "a", path: rootA }, { mode: "full" });
    const pendingB = orch.runTests({ projectId: "b", path: rootB }, { mode: "full" });
    await waitForStarted(stateDirA);
    await waitForStarted(stateDirB);

    sendCaseResult(stateDirA, "a.test.ts", "only-in-a", "passed");
    sendCaseResult(stateDirB, "b.test.ts", "only-in-b", "passed");
    await new Promise((r) => setTimeout(r, 50));

    const liveA = orch.getLiveRun("a");
    const liveB = orch.getLiveRun("b");
    expect(liveA!.tests.some((t) => t.name === "only-in-a")).toBe(true);
    expect(liveA!.tests.some((t) => t.name === "only-in-b")).toBe(false);
    expect(liveB!.tests.some((t) => t.name === "only-in-b")).toBe(true);
    expect(liveB!.tests.some((t) => t.name === "only-in-a")).toBe(false);

    fs.writeFileSync(path.join(stateDirA, "release"), "");
    fs.writeFileSync(path.join(stateDirB, "release"), "");
    await Promise.all([pendingA, pendingB]);
  }, 20_000);

  it("live state is retained (not undefined) immediately after a run errors, and replaced by the next run", async () => {
    const root = mkroot("test-mcp-live-retain-");
    const stateDir = path.join(root, ".test-mcp");
    const orch = new Orchestrator({ workerPath });

    const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    sendCaseResult(stateDir, "a.test.ts", "before-crash", "passed");
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(stateDir, "crash"), "");
    await pending.catch(() => undefined);

    const liveAfterCrash = orch.getLiveRun("p");
    expect(liveAfterCrash).toBeDefined();
    expect(liveAfterCrash!.tests.some((t) => t.name === "before-crash")).toBe(true);

    // Starting a fresh run replaces the entry (not merges with the stale one). `stateDir` is
    // reused, so wait on the live-state's own runId rather than the (already-existing) "started"
    // file, which the first run already wrote and this poll must not mistake for the second's.
    const secondRunId = orch.startRun({ projectId: "p", path: root }, { mode: "full" }).runId;
    await waitForLiveRunId(orch, "p", secondRunId);
    const liveSecondRun = orch.getLiveRun("p");
    expect(liveSecondRun!.runId).toBe(secondRunId);
    expect(liveSecondRun!.tests.some((t) => t.name === "before-crash")).toBe(false);
    fs.writeFileSync(path.join(stateDir, "release"), "");
  }, 20_000);

  it("stderr is captured into the live log ring AND still passed through to the daemon's own stderr unchanged", async () => {
    const root = mkroot("test-mcp-live-stderr-");
    const stateDir = path.join(root, ".test-mcp");
    const orch = new Orchestrator({ workerPath });

    const writeSpy = process.stderr.write.bind(process.stderr);
    const seen: string[] = [];
    // Intercept without breaking real stderr output -- record what's written, then delegate.
    (process.stderr.write as unknown) = ((chunk: unknown, ...rest: unknown[]) => {
      seen.push(String(chunk));
      // @ts-expect-error -- forwarding varargs to the real implementation
      return writeSpy(chunk, ...rest);
    }) as typeof process.stderr.write;

    const marker = "regression-guard-marker-line";
    try {
      const pending = orch.runTests({ projectId: "p", path: root }, { mode: "full" });
      await waitForStarted(stateDir);
      fs.writeFileSync(path.join(stateDir, "send-stderr"), marker);
      await new Promise((r) => setTimeout(r, 50));

      const live = orch.getLiveRun("p");
      expect(live!.logTail.some((l) => l.text === marker && l.stream === "stderr")).toBe(true);

      fs.writeFileSync(path.join(stateDir, "release"), "");
      await pending;
    } finally {
      process.stderr.write = writeSpy;
    }

    expect(seen.some((s) => s.includes(marker))).toBe(true);
  }, 20_000);
});
