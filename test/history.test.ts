import { afterAll, afterEach, beforeAll, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { Orchestrator, type RunRecord } from "../src/orchestrator/index.ts";
import {
  HISTORY_SCHEMA_VERSION,
  historyDir,
  writeRunRecord,
  loadHistory,
  pruneHistory,
} from "../src/history/index.ts";

let dir: string;

function makeRecord(runId: string, finishedAt: string): RunRecord {
  return {
    runId,
    projectId: "p1",
    startedAt: finishedAt,
    finishedAt,
    durationMs: 1,
    status: "complete",
    result: {
      success: true,
      summary: "1 passed",
      duration: 1,
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      failures: [],
      selection: { strategy: "full", reason: "full suite", files: [] },
    },
    failures: [],
  };
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("history module (Story 6.2)", () => {
  it("writes a schema-versioned record atomically and loads it back", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-hist-"));
    writeRunRecord(dir, makeRecord("run-1", "2026-07-15T10:00:00.000Z"));

    const onDisk = JSON.parse(fs.readFileSync(path.join(historyDir(dir), "run-1.json"), "utf8"));
    expect(onDisk.schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
    expect(onDisk.runId).toBe("run-1");

    const loaded = loadHistory(dir, 50);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].runId).toBe("run-1");
    // schemaVersion is stripped from the rehydrated record.
    expect((loaded[0] as Record<string, unknown>).schemaVersion).toBeUndefined();
  });

  it("loads newest-first and caps to the limit", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-hist-"));
    writeRunRecord(dir, makeRecord("old", "2026-07-15T10:00:00.000Z"));
    writeRunRecord(dir, makeRecord("mid", "2026-07-15T11:00:00.000Z"));
    writeRunRecord(dir, makeRecord("new", "2026-07-15T12:00:00.000Z"));

    const loaded = loadHistory(dir, 2);
    expect(loaded.map((r) => r.runId)).toEqual(["new", "mid"]);
  });

  it("prunes the oldest files past the cap", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-hist-"));
    // Write 5 with increasing mtime so prune order is deterministic.
    for (let i = 0; i < 5; i++) {
      const runId = `r${i}`;
      writeRunRecord(dir, makeRecord(runId, `2026-07-15T1${i}:00:00.000Z`));
      const t = new Date(2026, 6, 15, 10 + i).getTime() / 1000;
      fs.utimesSync(path.join(historyDir(dir), `${runId}.json`), t, t);
    }
    pruneHistory(dir, 2);
    const remaining = fs.readdirSync(historyDir(dir)).filter((n) => n.endsWith(".json")).sort();
    // The 2 newest (by mtime) survive.
    expect(remaining).toEqual(["r3.json", "r4.json"]);
  });

  it("skips a corrupt file and a wrong-schema file without throwing", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-hist-"));
    writeRunRecord(dir, makeRecord("good", "2026-07-15T10:00:00.000Z"));
    fs.writeFileSync(path.join(historyDir(dir), "corrupt.json"), "{ not json");
    fs.writeFileSync(
      path.join(historyDir(dir), "future.json"),
      JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION + 99, runId: "future" }),
    );

    const loaded = loadHistory(dir, 50);
    expect(loaded.map((r) => r.runId)).toEqual(["good"]);
  });

  it("returns [] when there is no history dir", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-hist-"));
    expect(loadHistory(dir, 50)).toEqual([]);
  });

  it("skips a record missing finishedAt on load", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-hist-"));
    writeRunRecord(dir, makeRecord("good", "2026-07-15T10:00:00.000Z"));
    fs.writeFileSync(
      path.join(historyDir(dir), "partial.json"),
      JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, runId: "partial" }),
    );
    expect(loadHistory(dir, 50).map((r) => r.runId)).toEqual(["good"]);
  });

  it("keeps the newest record and sweeps leftover .tmp files when pruning", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-hist-"));
    // Same-ms finishedAt would defeat an mtime sort; finishedAt-based prune keeps the true newest.
    writeRunRecord(dir, makeRecord("older", "2026-07-15T10:00:00.000Z"));
    writeRunRecord(dir, makeRecord("newest", "2026-07-15T12:00:00.000Z"));
    // A leftover temp file from a crashed mid-write.
    fs.writeFileSync(path.join(historyDir(dir), "stale.json.999.tmp"), "partial");

    pruneHistory(dir, 1);
    const remaining = fs.readdirSync(historyDir(dir));
    expect(remaining).toEqual(["newest.json"]); // older pruned, .tmp swept
  });
});

// A fake worker that returns a staged result, so a full run goes through the orchestrator's
// recordRun -> disk path without a real Vitest run.
const STUB_WORKER = `import fs from "node:fs";
import path from "node:path";
const stateDir = process.env.TEST_MCP_STATE_DIR;
process.on("message", (msg) => {
  if (msg && msg.type === "run") {
    const result = JSON.parse(fs.readFileSync(path.join(stateDir, "stub-result.json"), "utf8"));
    process.send({ type: "result", runId: msg.runId, result });
  } else if (msg && msg.type === "shutdown") {
    process.exit(0);
  }
});
process.send({ type: "ready" });
`;

describe("orchestrator run-history persistence round-trip (Story 6.2)", () => {
  let workerDir: string;
  let workerPath: string;

  beforeAll(() => {
    workerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-histw-")));
    workerPath = path.join(workerDir, "worker.mjs");
    fs.writeFileSync(workerPath, STUB_WORKER);
  });

  afterAll(() => {
    fs.rmSync(workerDir, { recursive: true, force: true });
  });

  it("persists a completed run and a fresh orchestrator rehydrates it from disk", async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-histr-")));
    const stateDir = path.join(dir, ".test-mcp");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "stub-result.json"),
      JSON.stringify({
        success: true,
        summary: "1 passed",
        duration: 1,
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        failures: [],
        selection: { strategy: "full", reason: "full suite", files: [] },
      }),
    );

    const orch = new Orchestrator({ workerPath });
    const project = { projectId: "hp", path: dir };
    await orch.runTests(project, {});
    expect(orch.getRunHistory("hp")).toHaveLength(1);

    // A file exists on disk under .test-mcp/history/.
    const files = fs.readdirSync(historyDir(dir)).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);

    // Simulate a restart: a fresh orchestrator has no memory until it loads from disk.
    const restarted = new Orchestrator({ workerPath });
    expect(restarted.getRunHistory("hp")).toHaveLength(0);
    restarted.loadHistory("hp", dir);
    const rehydrated = restarted.getRunHistory("hp");
    expect(rehydrated).toHaveLength(1);
    expect(rehydrated[0].result?.passed).toBe(1);
  }, 20_000);
});
