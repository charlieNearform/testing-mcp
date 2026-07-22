import { afterEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { ProjectRegistry } from "../src/registry/project-registry.ts";
import { Orchestrator } from "../src/orchestrator/index.ts";
import { handleUiRequest } from "../src/ui/index.ts";

const blockingWorkerPath = fileURLToPath(
  new URL("../test-fixtures/blocking-worker/worker.mjs", import.meta.url),
);

let tmp: string;
let root: string;
let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    // A connected SSE client (log/events, /ui/events) stays open indefinitely -- force-close it
    // rather than waiting for the client to disconnect on its own (same pattern as daemon close).
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      server!.closeAllConnections();
    });
    server = undefined;
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function get(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: p }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Open an SSE stream and collect `data:` payloads as they arrive, until stopped. */
function collectSse(port: number, p: string): { stop: () => void; events: Promise<() => string[]> } {
  const events: string[] = [];
  const req = http.request({ host: "127.0.0.1", port, method: "GET", path: p }, (res) => {
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      let m;
      while ((m = buf.match(/data: (.*)\n\n/))) {
        events.push(m[1]);
        buf = buf.slice(m.index! + m[0].length);
      }
    });
  });
  // Destroying an in-flight SSE request (stop(), below) is expected to emit a client-side
  // "socket hang up" error event -- without a listener, that's an unhandled error, not something
  // callers of stop() need to see.
  req.on("error", () => {});
  req.end();
  return { stop: () => req.destroy(), events: Promise.resolve(() => events) };
}

async function waitForStarted(stateDir: string): Promise<void> {
  const startedPath = path.join(stateDir, "started");
  for (let i = 0; i < 200 && !fs.existsSync(startedPath); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(fs.existsSync(startedPath)).toBe(true);
}

async function startUiOnlyServer(orchestrator: Orchestrator, registry: ProjectRegistry): Promise<number> {
  server = http.createServer((req, res) => {
    void handleUiRequest(req, res, { registry, orchestrator }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return address && typeof address === "object" ? address.port : 0;
}

describe("Human Monitoring UI live view (Story 8.7)", () => {
  it("snapshot's live field is present while running and absent once complete", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-ui-live-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-ui-live-project-"));
    fs.writeFileSync(path.join(root, "vitest.config.ts"), "export default {};\n");
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { projectId } = await registry.register(root);
    const orchestrator = new Orchestrator({ workerPath: blockingWorkerPath });
    const port = await startUiOnlyServer(orchestrator, registry);

    const stateDir = path.join(root, ".test-mcp");
    const pending = orchestrator.runTests({ projectId, path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "send-case-result"),
      JSON.stringify({ file: "a.test.ts", name: "t1", status: "passed" }),
    );
    await new Promise((r) => setTimeout(r, 30));

    const running = await get(port, "/ui/api/status");
    const runningSnap = JSON.parse(running.body) as {
      projects: Array<{ live?: { runId?: string } }>;
    };
    expect(runningSnap.projects[0].live).toBeDefined();
    // The UI links a "running" history row straight to this run's live detail view by matching
    // its runId, so the field has to actually be present on the live snapshot, not just tests/log.
    expect(typeof runningSnap.projects[0].live?.runId).toBe("string");
    expect(runningSnap.projects[0].live?.runId).not.toBe("");

    fs.writeFileSync(path.join(stateDir, "release"), "");
    await pending;

    const complete = await get(port, "/ui/api/status");
    const completeSnap = JSON.parse(complete.body) as { projects: Array<{ live?: unknown }> };
    expect(completeSnap.projects[0].live).toBeUndefined();
  }, 20_000);

  it("GET .../log returns the full ring; .../log/events sends only new lines on repeat pushes", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-ui-log-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-ui-log-project-"));
    fs.writeFileSync(path.join(root, "vitest.config.ts"), "export default {};\n");
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { projectId } = await registry.register(root);
    const orchestrator = new Orchestrator({ workerPath: blockingWorkerPath });
    const port = await startUiOnlyServer(orchestrator, registry);

    const stateDir = path.join(root, ".test-mcp");
    const pending = orchestrator.runTests({ projectId, path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    fs.writeFileSync(path.join(stateDir, "send-stdout"), "first-line");
    await new Promise((r) => setTimeout(r, 30));

    const { stop, events } = collectSse(port, `/ui/api/projects/${encodeURIComponent(projectId)}/log/events`);
    await new Promise((r) => setTimeout(r, 50)); // let the initial seed push land

    fs.writeFileSync(path.join(stateDir, "send-stdout"), "second-line");
    await new Promise((r) => setTimeout(r, 50));

    const got = (await events)();
    stop();
    expect(got.length).toBeGreaterThanOrEqual(2);
    const firstPush = JSON.parse(got[0]) as { log: Array<{ text: string }> };
    const secondPush = JSON.parse(got[1]) as { log: Array<{ text: string }> };
    expect(firstPush.log.some((l) => l.text === "first-line")).toBe(true);
    // The second push must NOT resend "first-line" -- only the new line.
    expect(secondPush.log.some((l) => l.text === "first-line")).toBe(false);
    expect(secondPush.log.some((l) => l.text === "second-line")).toBe(true);

    const full = await get(port, `/ui/api/projects/${encodeURIComponent(projectId)}/log`);
    const fullLog = JSON.parse(full.body) as { log: Array<{ text: string }> };
    expect(fullLog.log.some((l) => l.text === "first-line")).toBe(true);
    expect(fullLog.log.some((l) => l.text === "second-line")).toBe(true);

    fs.writeFileSync(path.join(stateDir, "release"), "");
    await pending;
  }, 20_000);

  it("a new run is still flagged (replace:true) to SSE listeners even if it emits a line-less status change first", async () => {
    // Regression: /log/events tracked "have we seen this run before" by updating its lastSeenRunId
    // on EVERY push attempt, including ones with nothing new to send. A run replaces the live log
    // with a fresh, empty array before it writes its first line, but other worker messages
    // (case-start, progress, ...) can trigger a push in that in-between window; before the fix,
    // that empty, line-less push would silently consume the "this is a new run" signal, so the
    // NEXT push (carrying the run's actual first line) went out with replace:false -- indistinguishable
    // from a same-run append. The UI's console log panel now depends on this to insert a "new run
    // started" separator instead of quietly concatenating two different runs' output.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-ui-log-newrun-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-ui-log-newrun-project-"));
    fs.writeFileSync(path.join(root, "vitest.config.ts"), "export default {};\n");
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const { projectId } = await registry.register(root);
    const orchestrator = new Orchestrator({ workerPath: blockingWorkerPath });
    const port = await startUiOnlyServer(orchestrator, registry);
    const stateDir = path.join(root, ".test-mcp");

    const runA = orchestrator.runTests({ projectId, path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    fs.writeFileSync(path.join(stateDir, "send-stdout"), "line-a");
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(stateDir, "release"), "");
    await runA;

    const { stop, events } = collectSse(port, `/ui/api/projects/${encodeURIComponent(projectId)}/log/events`);
    await new Promise((r) => setTimeout(r, 30)); // let the initial seed push (run A's line) land

    const runB = orchestrator.runTests({ projectId, path: root }, { mode: "full" });
    await waitForStarted(stateDir);
    // A line-less status change while run B's live log is already fresh/empty -- exactly the
    // window that used to let the run-boundary signal get silently swallowed.
    fs.writeFileSync(path.join(stateDir, "send-case-start"), JSON.stringify({ file: "b.test.ts", name: "t1" }));
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(stateDir, "send-stdout"), "line-b");
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(stateDir, "release"), "");
    await runB;

    const got = (await events)().map((g) => JSON.parse(g) as { log: Array<{ text: string }>; replace: boolean });
    stop();
    const lineBPush = got.find((p) => p.log.some((l) => l.text === "line-b"));
    expect(lineBPush).toBeDefined();
    expect(lineBPush!.replace).toBe(true);
  }, 20_000);

  it("both new log routes return an empty payload (not a 404) for an unknown projectId", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-ui-log-404-"));
    const registry = new ProjectRegistry(path.join(tmp, "registry.json"));
    const orchestrator = new Orchestrator({ workerPath: blockingWorkerPath });
    const port = await startUiOnlyServer(orchestrator, registry);

    const res = await get(port, "/ui/api/projects/does-not-exist/log");
    expect(res.status).toBe(200); // matches the existing /runs route: empty payload, not a 404
    const body = JSON.parse(res.body) as { log: unknown[] };
    expect(body.log).toEqual([]);

    const { stop, events } = collectSse(port, "/ui/api/projects/does-not-exist/log/events");
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(await (await events)()).toEqual([]); // no lines ever pushed for an unknown project
  });
});
