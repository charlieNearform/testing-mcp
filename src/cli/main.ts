import { Command } from "commander";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readLockfile,
  isPidAlive,
  loadOrCreateConfig,
} from "../daemon/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { computeProjectId } from "../registry/project-registry.js";
import { SCHEMA_VERSION } from "../index.js";
import { createSendFailureHandler, createTransportErrorHandler } from "./mcp-bridge-resilience.js";
import { ProjectLocalConfigSchema, type ProjectLocalConfig } from "../types/contracts.js";

/** CLI-side error for daemon reachability failures (maps to ErrorCode DaemonUnavailable). */
function daemonUnavailable(message: string): Error {
  return new Error(`DaemonUnavailable: ${message}`);
}

/**
 * Print a final line then exit once it has flushed. Writing to a pipe is async, so a bare
 * `console.log(x); process.exit(0)` can drop the line when stdout is piped (e.g. `| tee`);
 * exiting from the write callback guarantees the output is delivered first.
 */
function outExit(message: string, code = 0): void {
  process.stdout.write(`${message}\n`, () => process.exit(code));
}

/** Print a final error line to stderr then exit non-zero once it has flushed. */
function errExit(message: string, code = 1): void {
  process.stderr.write(`${message}\n`, () => process.exit(code));
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
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const parsed = ProjectLocalConfigSchema.partial().safeParse(raw);
      if (parsed.success && parsed.data.projectId) return parsed.data.projectId;
    } catch {
      // corrupt config — fall through and rewrite
    }
  }
  const projectId = computeProjectId(gitRoot);
  const cfg: ProjectLocalConfig = { schemaVersion: SCHEMA_VERSION, projectId, stateDir: ".test-mcp" };
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

/** The MCP client config entry every well-known client config file should carry. */
const MCP_BRIDGE_ENTRY = { command: "test-mcp", args: ["mcp-bridge"] };

/** Well-known MCP client config files, relative to the git root. */
const MCP_CLIENT_CONFIG_FILES = [".mcp.json", path.join(".cursor", "mcp.json")];

/**
 * Ensure each well-known MCP client config file has a "test-mcp" entry pointing at
 * `mcp-bridge` — no port or token in the file, so it's safe to commit and works unmodified
 * for any MCP client. Merges into an existing file without touching its other keys/servers;
 * idempotent (a no-op once the entry already matches). Returns the relative paths written.
 */
function ensureMcpClientConfigs(gitRoot: string): string[] {
  const written: string[] = [];
  for (const rel of MCP_CLIENT_CONFIG_FILES) {
    const filePath = path.join(gitRoot, rel);
    let parsed: Record<string, unknown> = {};
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      // file doesn't exist yet — start from an empty object
    }
    if (raw.trim().length > 0) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`${rel} is not valid JSON; fix or remove it before running register`);
      }
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new Error(`${rel} does not contain a JSON object at its root`);
      }
      parsed = json as Record<string, unknown>;
    }
    const existingServers =
      typeof parsed.mcpServers === "object" &&
      parsed.mcpServers !== null &&
      !Array.isArray(parsed.mcpServers)
        ? (parsed.mcpServers as Record<string, unknown>)
        : {};
    if (JSON.stringify(existingServers["test-mcp"]) === JSON.stringify(MCP_BRIDGE_ENTRY)) {
      continue; // already correct — don't rewrite/reformat the file
    }
    parsed.mcpServers = { ...existingServers, "test-mcp": MCP_BRIDGE_ENTRY };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
    written.push(rel);
  }
  return written;
}

/** Absolute path to this package's bin, resolved from the compiled module location. */
function binPath(): string {
  // dist/cli/main.js -> ../../bin/test-mcp.mjs
  return fileURLToPath(new URL("../../bin/test-mcp.mjs", import.meta.url));
}

/** Directories on the user's PATH, in order. */
function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function isWritableDir(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Choose where to symlink the CLI. Explicit `dir` wins; otherwise prefer a stable,
 * user-writable location already on PATH, falling back to the first writable PATH entry.
 */
function resolveLinkDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const preferred = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
  const onPath = new Set(pathDirs());
  for (const dir of preferred) {
    if (onPath.has(dir) && isWritableDir(dir)) return dir;
  }
  for (const dir of pathDirs()) {
    if (isWritableDir(dir)) return dir;
  }
  throw new Error(
    "no writable directory found on PATH; pass --dir <dir> (and ensure it is on your PATH)",
  );
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
      outExit(`test-mcp init: project ${projectId} ready at ${gitRoot}`);
    } catch (err) {
      errExit(`test-mcp init: ${(err as Error).message}`);
    }
  });

program
  .command("register")
  .description("Register the current project with the daemon (Story 1.3)")
  .option("--no-spawn", "do not auto-boot the daemon; fail if it is not running")
  .option(
    "--dir <dir>",
    "subfolder (relative to cwd) containing the vitest/vite config, if not at the git root",
  )
  .action(async (opts: { spawn: boolean; dir?: string }) => {
    try {
      const gitRoot = resolveGitRoot(process.cwd());
      ensureProjectConfig(gitRoot);
      ensureGitignore(gitRoot);
      const mcpConfigsWritten = ensureMcpClientConfigs(gitRoot);
      const registerPath = opts.dir ? path.resolve(process.cwd(), opts.dir) : gitRoot;
      if (registerPath !== gitRoot && !registerPath.startsWith(gitRoot + path.sep)) {
        return errExit(
          `test-mcp register: --dir ${opts.dir} resolves outside the git repository (${gitRoot})`,
        );
      }
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
        arguments: { path: registerPath },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      await client.close();
      const text = res.content?.[0]?.text;
      if (!text) {
        return errExit("test-mcp register: unexpected empty tool response");
      }
      const payload = JSON.parse(text) as {
        code?: string;
        message?: string;
        projectId?: string;
        path?: string;
      };
      if (res.isError) {
        return errExit(`test-mcp register: ${payload.code}: ${payload.message}`);
      }
      const mcpConfigNote =
        mcpConfigsWritten.length > 0
          ? `MCP client config written: ${mcpConfigsWritten.join(", ")} (safe to commit).`
          : "MCP client config already present (.mcp.json / .cursor/mcp.json).";
      return outExit(
        `test-mcp register: registered ${payload.projectId} (${payload.path})\n` +
          `Monitoring UI: http://127.0.0.1:${port}/ui\n${mcpConfigNote}`,
      );
    } catch (err) {
      return errExit(`test-mcp register: ${(err as Error).message}`);
    }
  });

program
  .command("start")
  .description("Start singleton daemon (Story 1.1)")
  .action(async () => {
    try {
      const h = await startDaemon();
      if (h.alreadyRunning) {
        return outExit(`test-mcp daemon already running (pid ${h.pid}, port ${h.port})`);
      }
      // Success path stays alive — this process IS the daemon; do not exit.
      console.log(`test-mcp daemon started (pid ${h.pid}, port ${h.port})`);
      const shutdown = async () => {
        await h.close();
        process.exit(0);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    } catch (err) {
      return errExit(`test-mcp start: ${(err as Error).message}`);
    }
  });

program
  .command("stop")
  .description("Stop daemon (Story 1.1)")
  .action(async () => {
    try {
      const r = await stopDaemon();
      if (r.stopped) {
        return outExit(`test-mcp daemon stopped (pid ${r.pid})`);
      }
      if (r.reason === "timeout") {
        return errExit(`test-mcp stop: daemon (pid ${r.pid}) did not shut down in time`);
      }
      return outExit("test-mcp daemon not running");
    } catch (err) {
      return errExit(`test-mcp stop: ${(err as Error).message}`);
    }
  });

program
  .command("status")
  .description("Daemon status (Story 1.1)")
  .action(async () => {
    try {
      const s = await getDaemonStatus();
      return outExit(
        s.running
          ? `test-mcp daemon: running (pid ${s.pid}, port ${s.port}, registered projects: ${s.registeredProjects.length})`
          : "test-mcp daemon: stopped",
      );
    } catch (err) {
      return errExit(`test-mcp status: ${(err as Error).message}`);
    }
  });

program
  .command("link")
  .description("Symlink the test-mcp CLI into a directory on your PATH")
  .option("--dir <dir>", "target directory (default: a writable directory already on PATH)")
  .option("-f, --force", "overwrite an existing test-mcp entry")
  .action((opts: { dir?: string; force?: boolean }) => {
    try {
      const dir = resolveLinkDir(opts.dir);
      const target = binPath();
      const linkPath = path.join(dir, "test-mcp");
      let existing: fs.Stats | undefined;
      try {
        existing = fs.lstatSync(linkPath);
      } catch {
        // nothing there yet
      }
      if (existing) {
        const current = existing.isSymbolicLink() ? fs.readlinkSync(linkPath) : undefined;
        if (current === target) {
          return outExit(`test-mcp link: already linked at ${linkPath}`);
        }
        // Only ever overwrite our own kind of thing (a symlink). Never clobber a real file,
        // even with --force — mirrors `unlink`'s "symlinks are the only things we delete".
        if (!existing.isSymbolicLink()) {
          return errExit(
            `test-mcp link: ${linkPath} exists and is not a symlink; refusing to overwrite a real file`,
          );
        }
        if (!opts.force) {
          return errExit(
            `test-mcp link: ${linkPath} already links elsewhere; pass --force to overwrite`,
          );
        }
        fs.rmSync(linkPath, { force: true });
      }
      fs.symlinkSync(target, linkPath);
      if (!new Set(pathDirs()).has(dir)) {
        console.error(`test-mcp link: warning — ${dir} is not on your PATH; add it to use \`test-mcp\` directly`);
      }
      return outExit(`test-mcp link: linked -> ${linkPath}`);
    } catch (err) {
      return errExit(`test-mcp link: ${(err as Error).message}`);
    }
  });

program
  .command("unlink")
  .description("Remove a test-mcp symlink created by `link`")
  .option("--dir <dir>", "directory to remove from (default: search PATH)")
  .option("-f, --force", "remove even if it points elsewhere")
  .action((opts: { dir?: string; force?: boolean }) => {
    try {
      const target = binPath();
      const dirs = opts.dir ? [path.resolve(opts.dir)] : pathDirs();
      for (const dir of dirs) {
        const linkPath = path.join(dir, "test-mcp");
        let st: fs.Stats;
        try {
          st = fs.lstatSync(linkPath);
        } catch {
          continue; // nothing here
        }
        // Never remove a real binary — only symlinks are ours to delete.
        if (!st.isSymbolicLink()) {
          if (opts.dir) {
            return errExit(`test-mcp unlink: ${linkPath} is not a symlink; refusing to remove`);
          }
          continue;
        }
        const points = fs.readlinkSync(linkPath);
        if (points !== target && !opts.force) {
          if (opts.dir) {
            return errExit(
              `test-mcp unlink: ${linkPath} points to ${points}, not this package; pass --force`,
            );
          }
          continue; // a different test-mcp; leave it alone when scanning
        }
        fs.rmSync(linkPath, { force: true });
        return outExit(`test-mcp unlink: removed ${linkPath}`);
      }
      return outExit("test-mcp unlink: no test-mcp symlink found");
    } catch (err) {
      return errExit(`test-mcp unlink: ${(err as Error).message}`);
    }
  });

program
  .command("ui")
  .description("Print the human monitoring UI URL")
  .action(() => {
    try {
      // Use the live daemon's port if running, else the configured/default port.
      const lock = readLockfile();
      let port: number;
      if (lock && isPidAlive(lock.pid)) {
        port = lock.port;
      } else {
        port = loadOrCreateConfig().port;
        console.error("test-mcp ui: daemon not running — start it with `test-mcp start` (or `test-mcp register`)");
      }
      // Bare URL on stdout so it's pipeable, e.g. `open "$(test-mcp ui)"`.
      return outExit(`http://127.0.0.1:${port}/ui`);
    } catch (err) {
      return errExit(`test-mcp ui: ${(err as Error).message}`);
    }
  });

program
  .command("mcp-bridge")
  .description(
    "Stdio<->HTTP bridge to the daemon; used by the .mcp.json / .cursor/mcp.json entry `register` writes",
  )
  .option("--no-spawn", "do not auto-boot the daemon; fail if it is not running")
  .action(async (opts: { spawn: boolean }) => {
    try {
      // commander sets opts.spawn = false when --no-spawn is passed.
      const { port, token } = await ensureDaemon(opts.spawn === false);

      const serverTransport = new StdioServerTransport();
      const daemonUrl = new URL(`http://127.0.0.1:${port}/mcp`);
      const authHeaders = { Authorization: `Bearer ${token}` };
      // The SDK's own default (maxRetries: 2) gives up SSE-reconnecting after a couple of
      // transient blips and only ever fires onerror, never onclose -- silently leaving the
      // stream dead for the rest of what can be a 15-20+ minute run. Raise the budget well
      // past that so ordinary network hiccups self-heal via the SDK's own capped backoff.
      const reconnectionOptions = {
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 200,
      };

      const makeClientTransport = (): StreamableHTTPClientTransport =>
        new StreamableHTTPClientTransport(daemonUrl, {
          requestInit: { headers: authHeaders },
          reconnectionOptions,
        });

      let clientTransport = makeClientTransport();

      let closing = false;
      const closeBoth = async (): Promise<void> => {
        if (closing) return;
        closing = true;
        await Promise.allSettled([serverTransport.close(), clientTransport.close()]);
        process.exit(0);
      };

      // Cached verbatim so a dead daemon-side session can be transparently recreated: replaying
      // `initialize` then `notifications/initialized` against a fresh transport reproduces the
      // handshake the daemon needs before it will accept anything else.
      let cachedInitialize: JSONRPCMessage | undefined;
      let cachedInitialized: JSONRPCMessage | undefined;

      // Shared across both the POST 404 path (below) and the SSE transport-error path so
      // concurrent triggers never race to build more than one fresh transport.
      let recreating: Promise<void> | undefined;
      const recreateSessionOnce = (): Promise<void> => {
        if (!recreating) {
          recreating = recreateSession().finally(() => {
            recreating = undefined;
          });
        }
        return recreating;
      };

      const handleTransportError = createTransportErrorHandler({
        hasCachedHandshake: () => cachedInitialize !== undefined && cachedInitialized !== undefined,
        recreateSession: recreateSessionOnce,
        log: (msg) => process.stderr.write(`${msg}\n`),
      });

      const bindClientHandlers = (transport: StreamableHTTPClientTransport): void => {
        transport.onmessage = (message: JSONRPCMessage) => {
          serverTransport.send(message).catch((err: unknown) => {
            process.stderr.write(
              `test-mcp mcp-bridge: send to client failed: ${(err as Error).message}\n`,
            );
          });
        };
        transport.onclose = () => void closeBoth();
        transport.onerror = handleTransportError;
      };

      // Build and start a fresh transport (same URL/auth), re-bind handlers, and replay the
      // cached handshake -- converts a daemon-side session that is gone (crash/restart/eviction)
      // into a fresh one without needing to know why the old one died.
      const recreateSession = async (): Promise<void> => {
        const stale = clientTransport;
        const fresh = makeClientTransport();
        bindClientHandlers(fresh);
        await fresh.start();
        if (cachedInitialize) await fresh.send(cachedInitialize);
        if (cachedInitialized) await fresh.send(cachedInitialized);
        clientTransport = fresh;
        // The stale transport's own SSE-reconnect loop keeps retrying (and logging) in the
        // background otherwise, for as long as its `maxRetries` budget lasts, having already been
        // superseded. Neutralize its handlers FIRST -- `onclose` is still bound to `closeBoth()`,
        // and `.close()` below fires it synchronously, which would tear down the whole bridge
        // (including the healthy `fresh` transport) right after a successful recovery.
        stale.onclose = undefined;
        stale.onerror = undefined;
        stale.onmessage = undefined;
        await stale.close().catch(() => {
          // Best-effort: the fresh transport is already live regardless of whether this succeeds.
        });
      };

      const handleSendFailure = createSendFailureHandler({
        // Both cached: a 404 in the narrow window after `initialize` but before `initialized` has
        // been forwarded must NOT replay a partial handshake -- the SSE listening stream only
        // starts as a side effect of sending `initialized` (SDK), so a partial replay would leave
        // the recreated session's server-push channel permanently unopened.
        hasCachedHandshake: () => cachedInitialize !== undefined && cachedInitialized !== undefined,
        // Routed through the shared de-duped wrapper so a POST-triggered 404 and an SSE
        // transport-error recovery never race to build two fresh transports concurrently.
        recreateSession: recreateSessionOnce,
        retrySend: (message) => clientTransport.send(message),
        log: (msg) => process.stderr.write(`${msg}\n`),
      });

      // A raw JSON-RPC pipe: both sides are plain Transports (not Client/Server), so every
      // message — including the initial handshake — is forwarded verbatim in each direction.
      serverTransport.onmessage = (message: JSONRPCMessage) => {
        if ("method" in message) {
          if (message.method === "initialize") cachedInitialize = message;
          else if (message.method === "notifications/initialized") cachedInitialized = message;
        }

        clientTransport.send(message).catch((err: unknown) => handleSendFailure(message, err));
      };
      bindClientHandlers(clientTransport);
      serverTransport.onclose = () => void closeBoth();
      serverTransport.onerror = (err: Error) =>
        process.stderr.write(`test-mcp mcp-bridge: stdio transport error: ${err.message}\n`);

      await clientTransport.start();
      await serverTransport.start();
      process.once("SIGTERM", () => void closeBoth());
      process.once("SIGINT", () => void closeBoth());
    } catch (err) {
      return errExit(`test-mcp mcp-bridge: ${(err as Error).message}`);
    }
  });

// Default action: show help when no command provided
if (!process.argv.slice(2).length) {
  program.help();
}

program.parse();
