import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { startDaemon, type DaemonHandle } from "../src/daemon/index.ts";

let home: string;
let handle: DaemonHandle | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-ui-"));
  process.env.TEST_MCP_HOME = home;
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ schemaVersion: 1, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }),
  );
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  delete process.env.TEST_MCP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
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

/** Open an SSE stream and resolve with the first `data:` payload, then abort. */
function firstSseEvent(port: number, p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: p }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        const m = buf.match(/data: (.*)\n\n/);
        if (m) {
          req.destroy();
          resolve(m[1]);
        }
      });
      res.on("error", () => {});
    });
    req.on("error", reject);
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error("no SSE event received"));
    }, 5000);
  });
}

describe("Human Monitoring UI (Epic 5)", () => {
  it("serves the status page over loopback without a bearer token", async () => {
    handle = await startDaemon();
    const res = await get(handle.port, "/ui");
    expect(res.status).toBe(200);
    expect(res.body).toContain("test-mcp");
    expect(res.body).toContain("/ui/events");
  });

  it("returns a JSON status snapshot", async () => {
    handle = await startDaemon();
    const res = await get(handle.port, "/ui/api/status");
    expect(res.status).toBe(200);
    const snap = JSON.parse(res.body) as { serverTime: string; projects: unknown[] };
    expect(Array.isArray(snap.projects)).toBe(true);
    expect(snap.serverTime).toBeTruthy();
  });

  it("pushes the latest snapshot immediately on (re)connect for resilience", async () => {
    handle = await startDaemon();
    const first = await firstSseEvent(handle.port, "/ui/events");
    expect(JSON.parse(first)).toHaveProperty("projects");
    // A reconnect gets a fresh snapshot too (EventSource resilience contract).
    const second = await firstSseEvent(handle.port, "/ui/events");
    expect(JSON.parse(second)).toHaveProperty("projects");
  });
});
