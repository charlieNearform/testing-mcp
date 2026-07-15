import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as http from "node:http";
import { z } from "zod";
import { SCHEMA_VERSION } from "../index.js";
import { createMcpRequestListener } from "../mcp/server.js";
import { ProjectRegistry } from "../registry/project-registry.js";
import { Orchestrator } from "../orchestrator/index.js";
import { WatchManager } from "../watch/index.js";

export { SCHEMA_VERSION };

/** Daemon config schema — the single source of truth; `DaemonConfig` is inferred from it. */
const DaemonConfigSchema = z.object({
  schemaVersion: z.number(),
  port: z.number(),
  maxConcurrentWorkers: z.number(),
  workerIdleTtlMs: z.number(),
  /**
   * Per-daemon bearer secret for /mcp auth. Stable across restarts (persisted here so MCP
   * clients can be configured statically). Generated on first start; overridable via
   * TEST_MCP_TOKEN. Optional for configs written before it existed.
   */
  token: z.string().optional(),
});

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

export interface Lockfile {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export interface DaemonHandle {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  alreadyRunning: boolean;
  close(): Promise<void>;
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  registeredProjects: string[];
}

export function centralDir(): string {
  return process.env.TEST_MCP_HOME || path.join(os.homedir(), ".test-mcp");
}

export function configPath(): string {
  return path.join(centralDir(), "config.json");
}

/** Plaintext bearer-token file (0600) so a shell `headersHelper` can read it without
 *  parsing JSON — powers the env-var-free `.mcp.json` MCP client flow. */
export function tokenFilePath(): string {
  return path.join(centralDir(), "token");
}

/** Write the plaintext token file (0600), no trailing newline. Kept in sync with the live
 *  daemon token so a `headersHelper` reading it always sends the current bearer. */
export function writeTokenFile(token: string): void {
  fs.mkdirSync(centralDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFilePath(), token, { mode: 0o600 });
  fs.chmodSync(tokenFilePath(), 0o600);
}

export function lockfilePath(): string {
  return path.join(centralDir(), "daemon.lock");
}

export function registryPath(): string {
  return path.join(centralDir(), "registry.json");
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but we can't signal it — still "alive".
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function readLockfile(): Lockfile | null {
  try {
    const content = fs.readFileSync(lockfilePath(), "utf8");
    return JSON.parse(content) as Lockfile;
  } catch {
    return null;
  }
}

export function loadOrCreateConfig(): DaemonConfig {
  const dir = centralDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (fs.existsSync(configPath())) {
    const content = fs.readFileSync(configPath(), "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error(`config.json is not valid JSON at ${configPath()}`);
    }
    const result = DaemonConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid config.json at ${configPath()}: ${result.error.message}`);
    }
    const parsed = result.data;

    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        "Unsupported config schemaVersion " +
          parsed.schemaVersion +
          " (expected " +
          SCHEMA_VERSION +
          ")"
      );
    }

    return parsed;
  }

  const cfg: DaemonConfig = {
    schemaVersion: SCHEMA_VERSION,
    port: 7420,
    maxConcurrentWorkers: Math.max(1, os.cpus().length),
    workerIdleTtlMs: 300000,
  };

  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

/**
 * Resolve the daemon's bearer token. Precedence: `TEST_MCP_TOKEN` env override →
 * persisted `config.token` → generate once and persist back to config.json. The token is
 * stable across restarts (no longer rotates per start) so MCP clients can hard-code it.
 * The env override is not persisted. Persisted token file is `0600`.
 */
export function resolveToken(cfg: DaemonConfig): string {
  const fromEnv = process.env.TEST_MCP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (cfg.token) return cfg.token;
  const token = crypto.randomBytes(32).toString("hex");
  cfg.token = token;
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(configPath(), 0o600);
  return token;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const dir = centralDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const existing = readLockfile();

  if (existing && isPidAlive(existing.pid)) {
    return {
      pid: existing.pid,
      port: existing.port,
      token: existing.token,
      startedAt: existing.startedAt,
      alreadyRunning: true,
      close: async () => {},
    };
  }

  if (existing) {
    fs.rmSync(lockfilePath(), { force: true });
  }

  const cfg = loadOrCreateConfig();
  const token = resolveToken(cfg);
  writeTokenFile(token); // keep the plaintext token file current for headersHelper clients

  let registry = new ProjectRegistry(registryPath());
  try {
    await registry.load();
  } catch (err) {
    registry = new ProjectRegistry(registryPath());
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `test-mcp daemon: could not load registry (${message}); ` +
        `starting with an empty registry\n`,
    );
  }
  const orchestrator = new Orchestrator({ maxConcurrentWorkers: cfg.maxConcurrentWorkers });
  const watchManager = new WatchManager(orchestrator);
  const server = http.createServer(
    createMcpRequestListener({ token, registry, orchestrator, watchManager }),
  );

  await new Promise<void>((resolve, reject) => {
    const onBindError = (err: Error): void => {
      server.close();
      reject(err);
    };
    server.once("error", onBindError);
    server.listen(cfg.port, "127.0.0.1", () => {
      // Bind succeeded: drop the reject-on-error handler so a later transient socket error
      // can't silently close the live daemon. Log subsequent errors instead.
      server.removeListener("error", onBindError);
      server.on("error", (err) => {
        process.stderr.write(`test-mcp daemon: server error: ${err.message}\n`);
      });
      resolve();
    });
  });

  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : cfg.port;

  const lock: Lockfile = {
    pid: process.pid,
    port,
    token,
    startedAt: new Date().toISOString(),
  };

  fs.writeFileSync(lockfilePath(), JSON.stringify(lock, null, 2), {
    mode: 0o600,
  });
  fs.chmodSync(lockfilePath(), 0o600);

  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const cur = readLockfile();
    if (cur && cur.pid === process.pid) {
      fs.rmSync(lockfilePath(), { force: true });
    }
  };

  return {
    pid: process.pid,
    port,
    token,
    startedAt: lock.startedAt,
    alreadyRunning: false,
    close,
  };
}

export async function stopDaemon(): Promise<{
  stopped: boolean;
  pid?: number;
  reason?: string;
}> {
  const lock = readLockfile();

  if (!lock) {
    return { stopped: false, reason: "not running" };
  }

  if (!isPidAlive(lock.pid)) {
    fs.rmSync(lockfilePath(), { force: true });
    return { stopped: false, reason: "stale" };
  }

  try {
    process.kill(lock.pid, "SIGTERM");
  } catch (e: unknown) {
    // ESRCH: the process died between the liveness check and the signal.
    if ((e as NodeJS.ErrnoException)?.code === "ESRCH") {
      fs.rmSync(lockfilePath(), { force: true });
      return { stopped: false, pid: lock.pid, reason: "stale" };
    }
    throw e;
  }

  // Poll up to 50 iterations of 100ms for the daemon to clean up its own lockfile.
  for (let i = 0; i < 50; i++) {
    if (!fs.existsSync(lockfilePath())) {
      return { stopped: true, pid: lock.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Timed out. Do not claim success while the process is still alive, and do not
  // delete a live daemon's lockfile.
  if (isPidAlive(lock.pid)) {
    return { stopped: false, pid: lock.pid, reason: "timeout" };
  }
  fs.rmSync(lockfilePath(), { force: true });
  return { stopped: true, pid: lock.pid };
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  const lock = readLockfile();

  if (!lock) {
    return { running: false, registeredProjects: [] };
  }

  if (!isPidAlive(lock.pid)) {
    fs.rmSync(lockfilePath(), { force: true });
    return { running: false, registeredProjects: [] };
  }

  let registeredProjects: string[] = [];
  try {
    const reg = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as {
      projects?: Record<string, unknown>;
    };
    registeredProjects = Object.keys(reg.projects ?? {});
  } catch {
    // no registry file yet
  }
  return {
    running: true,
    pid: lock.pid,
    port: lock.port,
    registeredProjects,
  };
}
