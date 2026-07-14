import { Command } from "commander";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readLockfile,
  isPidAlive,
} from "../daemon/index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { computeProjectId } from "../registry/project-registry.js";
import { SCHEMA_VERSION } from "../index.js";

/** CLI-side error for daemon reachability failures (maps to ErrorCode DaemonUnavailable). */
function daemonUnavailable(message: string): Error {
  return new Error(`DaemonUnavailable: ${message}`);
}

/** Resolve the git root for a directory, or throw a clear error if not a git repo. */
function resolveGitRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(`not a git repository (or git not installed): ${cwd}`);
  }
}

/** Create <gitRoot>/.test-mcp/config.json if absent (idempotent). Returns the projectId. */
function ensureProjectConfig(gitRoot: string): string {
  const stateDir = path.join(gitRoot, ".test-mcp");
  const cfgPath = path.join(stateDir, "config.json");
  fs.mkdirSync(stateDir, { recursive: true });
  if (fs.existsSync(cfgPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { projectId?: string };
      if (existing.projectId) return existing.projectId;
    } catch {
      // corrupt config — fall through and rewrite
    }
  }
  const projectId = computeProjectId(gitRoot);
  const cfg = { schemaVersion: SCHEMA_VERSION, projectId, stateDir: ".test-mcp" };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return projectId;
}

/** Ensure ".test-mcp/" is present in <gitRoot>/.gitignore (idempotent). */
function ensureGitignore(gitRoot: string): void {
  const gitignorePath = path.join(gitRoot, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    // no .gitignore yet
  }
  const hasEntry = content
    .split(/\r?\n/)
    .some((line) => line.trim() === ".test-mcp/" || line.trim() === ".test-mcp");
  if (hasEntry) return;
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignorePath, `${prefix}.test-mcp/\n`);
}

/** Absolute path to this package's bin, resolved from the compiled module location. */
function binPath(): string {
  // dist/cli/main.js -> ../../bin/test-mcp.mjs
  return fileURLToPath(new URL("../../bin/test-mcp.mjs", import.meta.url));
}

/** Ensure the singleton daemon is running; auto-boot it detached unless noSpawn. Returns the lockfile. */
async function ensureDaemon(noSpawn: boolean): Promise<{ port: number; token: string }> {
  const existing = readLockfile();
  if (existing && isPidAlive(existing.pid)) return { port: existing.port, token: existing.token };
  if (noSpawn) {
    throw daemonUnavailable(
      "daemon not running and --no-spawn set; start it with `test-mcp start`",
    );
  }
  let spawnErr: Error | undefined;
  const child = spawn(process.execPath, [binPath(), "start"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.once("error", (err) => {
    spawnErr = err;
  });
  child.unref();
  // Poll up to ~5s for the daemon to write a live lockfile.
  for (let i = 0; i < 50; i++) {
    if (spawnErr) {
      throw daemonUnavailable(`failed to start daemon: ${spawnErr.message}`);
    }
    const lock = readLockfile();
    if (lock && isPidAlive(lock.pid)) return { port: lock.port, token: lock.token };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw daemonUnavailable("daemon did not become ready within 5s");
}

const program = new Command();
program.name("test-mcp").description("MCP test orchestration daemon").version("0.0.0");

program
  .command("init")
  .description("Initialize .test-mcp in a consumer project (Story 1.3)")
  .action(() => {
    try {
      const gitRoot = resolveGitRoot(process.cwd());
      const projectId = ensureProjectConfig(gitRoot);
      ensureGitignore(gitRoot);
      console.log(`test-mcp init: project ${projectId} ready at ${gitRoot}`);
    } catch (err) {
      console.error(`test-mcp init: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("register")
  .description("Register the current project with the daemon (Story 1.3)")
  .option("--no-spawn", "do not auto-boot the daemon; fail if it is not running")
  .action(async (opts: { spawn: boolean }) => {
    try {
      const gitRoot = resolveGitRoot(process.cwd());
      ensureProjectConfig(gitRoot);
      ensureGitignore(gitRoot);
      // commander sets opts.spawn = false when --no-spawn is passed.
      const { port, token } = await ensureDaemon(opts.spawn === false);
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
      );
      const client = new Client({ name: "test-mcp-cli", version: "0.0.0" });
      await client.connect(transport);
      const res = (await client.callTool({
        name: "register_project",
        arguments: { path: gitRoot },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      await client.close();
      const text = res.content?.[0]?.text;
      if (!text) {
        console.error("test-mcp register: unexpected empty tool response");
        process.exit(1);
      }
      const payload = JSON.parse(text) as {
        code?: string;
        message?: string;
        projectId?: string;
        path?: string;
      };
      if (res.isError) {
        console.error(`test-mcp register: ${payload.code}: ${payload.message}`);
        process.exit(1);
      }
      console.log(`test-mcp register: registered ${payload.projectId} (${payload.path})`);
      process.exit(0);
    } catch (err) {
      console.error(`test-mcp register: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("start")
  .description("Start singleton daemon (Story 1.1)")
  .action(async () => {
    try {
      const h = await startDaemon();
      if (h.alreadyRunning) {
        console.log(`test-mcp daemon already running (pid ${h.pid}, port ${h.port})`);
        process.exit(0);
      }
      console.log(`test-mcp daemon started (pid ${h.pid}, port ${h.port})`);
      const shutdown = async () => {
        await h.close();
        process.exit(0);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    } catch (err) {
      console.error(`test-mcp start: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("stop")
  .description("Stop daemon (Story 1.1)")
  .action(async () => {
    try {
      const r = await stopDaemon();
      if (r.stopped) {
        console.log(`test-mcp daemon stopped (pid ${r.pid})`);
        process.exit(0);
      }
      if (r.reason === "timeout") {
        console.error(`test-mcp stop: daemon (pid ${r.pid}) did not shut down in time`);
        process.exit(1);
      }
      console.log("test-mcp daemon not running");
      process.exit(0);
    } catch (err) {
      console.error(`test-mcp stop: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Daemon status (Story 1.1)")
  .action(async () => {
    try {
      const s = await getDaemonStatus();
      console.log(
        s.running
          ? `test-mcp daemon: running (pid ${s.pid}, port ${s.port}, registered projects: ${s.registeredProjects.length})`
          : "test-mcp daemon: stopped"
      );
      process.exit(0);
    } catch (err) {
      console.error(`test-mcp status: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// Default action: show help when no command provided
if (!process.argv.slice(2).length) {
  program.help();
}

program.parse();
