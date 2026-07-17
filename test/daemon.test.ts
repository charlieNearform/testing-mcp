import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  loadOrCreateConfig,
  resolveToken,
  readLockfile,
  configPath,
  lockfilePath,
  tokenFilePath,
  isPidAlive,
  type DaemonConfig,
  type DaemonHandle,
  SCHEMA_VERSION,
} from "../src/daemon/index.js";

describe("daemon", () => {
  let tempHome: string;
  const openHandles: DaemonHandle[] = [];

  // Track handles so afterEach can always release bound servers, even if a test throws.
  async function start(): Promise<DaemonHandle> {
    const h = await startDaemon();
    openHandles.push(h);
    return h;
  }

  // Hermetic config: port 0 => OS assigns a free ephemeral port (never binds fixed 7420).
  function writePortZeroConfig(): void {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 })
    );
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-"));
    process.env.TEST_MCP_HOME = tempHome;
    // Clear any ambient TEST_MCP_TOKEN (e.g. exported in the dev's shell) so token
    // resolution/persistence tests are hermetic regardless of the environment.
    delete process.env.TEST_MCP_TOKEN;
    fs.mkdirSync(tempHome, { recursive: true });
    writePortZeroConfig();
  });

  afterEach(async () => {
    while (openHandles.length) {
      const h = openHandles.pop()!;
      try {
        await h.close();
      } catch {
        // best effort
      }
    }
    delete process.env.TEST_MCP_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("loadOrCreateConfig", () => {
    it("creates config with default port on first run", () => {
      fs.rmSync(configPath(), { force: true }); // remove the hermetic port-0 config to test creation
      const config = loadOrCreateConfig();
      expect(config.schemaVersion).toBe(SCHEMA_VERSION);
      expect(config.port).toBe(7420);
      expect(config.maxConcurrentWorkers).toBeGreaterThanOrEqual(1);
      expect(config.workerIdleTtlMs).toBe(300000);
      expect(fs.existsSync(configPath())).toBe(true);
    });

    it("loads existing config on second run", () => {
      const config1 = loadOrCreateConfig();
      const config2 = loadOrCreateConfig();
      expect(config2.port).toBe(config1.port);
    });

    it("throws when schemaVersion mismatch", () => {
      const badConfig: DaemonConfig = {
        schemaVersion: 999,
        port: 0,
        maxConcurrentWorkers: 1,
        workerIdleTtlMs: 300000,
      };
      fs.writeFileSync(configPath(), JSON.stringify(badConfig));
      expect(() => loadOrCreateConfig()).toThrow(
        "Unsupported config schemaVersion 999 (expected 1)"
      );
    });

    it("throws on a structurally invalid config (wrong field type)", () => {
      fs.writeFileSync(
        configPath(),
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, port: "not-a-number", maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }),
      );
      expect(() => loadOrCreateConfig()).toThrow(/Invalid config\.json/);
    });

    it("throws on non-JSON config content", () => {
      fs.writeFileSync(configPath(), "{ not json");
      expect(() => loadOrCreateConfig()).toThrow(/not valid JSON/);
    });

    it("creates a fresh config with the documented defaultRunWaitMs/staleTestGraceMs defaults (Story 8.3)", () => {
      fs.rmSync(configPath(), { force: true });
      const config = loadOrCreateConfig();
      expect(config.defaultRunWaitMs).toBe(10_000);
      expect(config.staleTestGraceMs).toBe(5000);
    });

    it("fills in defaultRunWaitMs/staleTestGraceMs defaults for a config written before they existed (Story 8.3)", () => {
      fs.writeFileSync(
        configPath(),
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }),
      );
      const config = loadOrCreateConfig();
      expect(config.defaultRunWaitMs).toBe(10_000);
      expect(config.staleTestGraceMs).toBe(5000);
    });

    it("preserves an explicit defaultRunWaitMs of null (wait forever) across a load (Story 8.3)", () => {
      fs.writeFileSync(
        configPath(),
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          port: 0,
          maxConcurrentWorkers: 1,
          workerIdleTtlMs: 300000,
          defaultRunWaitMs: null,
        }),
      );
      const config = loadOrCreateConfig();
      expect(config.defaultRunWaitMs).toBeNull();
    });
  });

  describe("resolveToken", () => {
    afterEach(() => {
      delete process.env.TEST_MCP_TOKEN;
    });

    it("generates a token and persists it into config.json when absent", () => {
      const cfg = loadOrCreateConfig();
      expect(cfg.token).toBeUndefined();
      const token = resolveToken(cfg);
      expect(token).toHaveLength(64); // 32 bytes hex
      const persisted = JSON.parse(fs.readFileSync(configPath(), "utf8")) as { token?: string };
      expect(persisted.token).toBe(token);
    });

    it("reuses the persisted token on a subsequent load (stable across restarts)", () => {
      const first = resolveToken(loadOrCreateConfig());
      const second = resolveToken(loadOrCreateConfig());
      expect(second).toBe(first);
    });

    it("lets TEST_MCP_TOKEN override without persisting it", () => {
      process.env.TEST_MCP_TOKEN = "override-secret";
      const cfg = loadOrCreateConfig();
      expect(resolveToken(cfg)).toBe("override-secret");
      const persisted = JSON.parse(fs.readFileSync(configPath(), "utf8")) as { token?: string };
      expect(persisted.token).toBeUndefined(); // env override is not written back
    });
  });

  describe("startDaemon", () => {
    it("keeps the same bearer token across restarts", async () => {
      const first = await start();
      const token = first.token;
      await first.close();
      openHandles.pop();
      const second = await start();
      expect(second.token).toBe(token);
    });


    it("writes lockfile with correct fields", async () => {
      const handle = await start();
      expect(handle.pid).toBe(process.pid);
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.token).toHaveLength(64); // 32 bytes hex
      expect(handle.alreadyRunning).toBe(false);

      const lock = readLockfile();
      expect(lock).not.toBeNull();
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.port).toBe(handle.port);
      expect(lock?.token).toBe(handle.token);

      // Plaintext token file is written 0600 and matches the live token (headersHelper flow).
      expect(fs.readFileSync(tokenFilePath(), "utf8")).toBe(handle.token);
      expect(fs.statSync(tokenFilePath()).mode & 0o777).toBe(0o600);
    });

    it("server actually listens on loopback", async () => {
      const handle = await start();
      const res = await fetch(`http://127.0.0.1:${handle.port}/`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; daemon: string };
      expect(body.status).toBe("ok");
      expect(body.daemon).toBe("test-mcp");
    });

    it("returns alreadyRunning=true on second call while first is open", async () => {
      const handle1 = await start();
      const handle2 = await start();
      expect(handle2.alreadyRunning).toBe(true);
      expect(handle2.pid).toBe(handle1.pid);
      expect(handle2.port).toBe(handle1.port);
    });

    it("reclaims stale lockfile with dead pid", async () => {
      fs.writeFileSync(
        lockfilePath(),
        JSON.stringify({ pid: 2147483647, port: 1, token: "x", startedAt: new Date().toISOString() })
      );
      const handle = await start();
      expect(handle.pid).toBe(process.pid);
      expect(handle.alreadyRunning).toBe(false);
      expect(readLockfile()?.pid).toBe(process.pid);
    });
  });

  describe("getDaemonStatus", () => {
    it("returns running=false when no lockfile", async () => {
      const status = await getDaemonStatus();
      expect(status.running).toBe(false);
      expect(status.registeredProjects).toEqual([]);
    });

    it("returns running=true while handle is open, false after close", async () => {
      const handle = await startDaemon(); // not tracked: we close it explicitly below
      const status = await getDaemonStatus();
      expect(status.running).toBe(true);
      expect(status.pid).toBe(handle.pid);
      expect(status.port).toBe(handle.port);
      expect(status.registeredProjects).toEqual([]);

      await handle.close();
      const status2 = await getDaemonStatus();
      expect(status2.running).toBe(false);
    });

    it("clears a stale lockfile (dead pid)", async () => {
      fs.writeFileSync(
        lockfilePath(),
        JSON.stringify({ pid: 2147483647, port: 1, token: "x", startedAt: new Date().toISOString() })
      );
      const status = await getDaemonStatus();
      expect(status.running).toBe(false);
      expect(fs.existsSync(lockfilePath())).toBe(false);
    });
  });

  describe("stopDaemon", () => {
    it("returns not running when no lockfile", async () => {
      const result = await stopDaemon();
      expect(result.stopped).toBe(false);
      expect(result.reason).toBe("not running");
    });

    it("clears a stale lockfile", async () => {
      fs.writeFileSync(
        lockfilePath(),
        JSON.stringify({ pid: 2147483647, port: 1, token: "x", startedAt: new Date().toISOString() })
      );
      const result = await stopDaemon();
      expect(result.stopped).toBe(false);
      expect(result.reason).toBe("stale");
      expect(fs.existsSync(lockfilePath())).toBe(false);
    });
  });

  describe("isPidAlive", () => {
    it("detects current process as alive", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it("detects dead sentinel pid as dead", () => {
      expect(isPidAlive(2147483647)).toBe(false);
    });

    it("rejects invalid pids (<= 0)", () => {
      expect(isPidAlive(0)).toBe(false);
      expect(isPidAlive(-1)).toBe(false);
    });
  });
});
