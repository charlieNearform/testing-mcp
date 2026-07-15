import { Command } from "commander";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readLockfile,
  isPidAlive,
} from "../daemon/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
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
      return outExit(`test-mcp register: registered ${payload.projectId} (${payload.path})`);
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

// Default action: show help when no command provided
if (!process.argv.slice(2).length) {
  program.help();
}

program.parse();
