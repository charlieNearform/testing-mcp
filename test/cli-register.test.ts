import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = path.join(repoRoot, "bin", "test-mcp.mjs");

let home: string; // central daemon dir (TEST_MCP_HOME)
let project: string; // a temp git repo with a vitest config
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cli-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cli-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: project });
  fs.writeFileSync(path.join(project, "vitest.config.ts"), "export default {};\n");
  // port 0 => OS picks a free port for the auto-booted daemon.
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ schemaVersion: 1, port: 0, maxConcurrentWorkers: 1, workerIdleTtlMs: 300000 }),
  );
  env = { ...process.env, TEST_MCP_HOME: home };
});

afterEach(async () => {
  // Best-effort daemon stop so no server leaks.
  try {
    await execFileAsync(process.execPath, [bin, "stop"], { cwd: project, env });
  } catch {
    // ignore
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe("test-mcp register (CLI)", () => {
  it("init creates repo config + gitignore entry (idempotent)", async () => {
    await execFileAsync(process.execPath, [bin, "init"], { cwd: project, env });
    const cfg = JSON.parse(fs.readFileSync(path.join(project, ".test-mcp", "config.json"), "utf8"));
    expect(cfg.projectId).toBeTruthy();
    expect(cfg.stateDir).toBe(".test-mcp");
    expect(fs.readFileSync(path.join(project, ".gitignore"), "utf8")).toContain(".test-mcp/");
    // idempotent: second run keeps the same projectId and doesn't duplicate the ignore line.
    await execFileAsync(process.execPath, [bin, "init"], { cwd: project, env });
    const cfg2 = JSON.parse(fs.readFileSync(path.join(project, ".test-mcp", "config.json"), "utf8"));
    expect(cfg2.projectId).toBe(cfg.projectId);
    const ignoreLines = fs
      .readFileSync(path.join(project, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() === ".test-mcp/");
    expect(ignoreLines).toHaveLength(1);
  });

  it("register --no-spawn fails when the daemon is not running", async () => {
    await expect(
      execFileAsync(process.execPath, [bin, "register", "--no-spawn"], { cwd: project, env }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("DaemonUnavailable"),
    });
  });

  it("register auto-boots the daemon and registers the project", async () => {
    const { stdout } = await execFileAsync(process.execPath, [bin, "register"], {
      cwd: project,
      env,
    });
    expect(stdout).toContain("registered");
    // The central registry.json now contains this project's id.
    const reg = JSON.parse(fs.readFileSync(path.join(home, "registry.json"), "utf8"));
    const cfg = JSON.parse(fs.readFileSync(path.join(project, ".test-mcp", "config.json"), "utf8"));
    expect(Object.keys(reg.projects)).toContain(cfg.projectId);
    // status reflects the registration.
    const status = await execFileAsync(process.execPath, [bin, "status"], { cwd: project, env });
    expect(status.stdout).toContain("registered projects: 1");
  });

  it("register writes .mcp.json and .cursor/mcp.json with the mcp-bridge entry", async () => {
    const { stdout } = await execFileAsync(process.execPath, [bin, "register"], {
      cwd: project,
      env,
    });
    expect(stdout).toContain("MCP client config written: .mcp.json, .cursor/mcp.json");
    const bridgeEntry = { command: "test-mcp", args: ["mcp-bridge"] };
    const mcpJson = JSON.parse(fs.readFileSync(path.join(project, ".mcp.json"), "utf8"));
    expect(mcpJson.mcpServers["test-mcp"]).toEqual(bridgeEntry);
    const cursorJson = JSON.parse(
      fs.readFileSync(path.join(project, ".cursor", "mcp.json"), "utf8"),
    );
    expect(cursorJson.mcpServers["test-mcp"]).toEqual(bridgeEntry);
  });

  it("register merges into an existing .mcp.json without touching other servers/keys", async () => {
    fs.writeFileSync(
      path.join(project, ".mcp.json"),
      JSON.stringify({ someOtherSetting: true, mcpServers: { other: { command: "other" } } }, null, 2),
    );
    await execFileAsync(process.execPath, [bin, "register"], { cwd: project, env });
    const mcpJson = JSON.parse(fs.readFileSync(path.join(project, ".mcp.json"), "utf8"));
    expect(mcpJson.someOtherSetting).toBe(true);
    expect(mcpJson.mcpServers.other).toEqual({ command: "other" });
    expect(mcpJson.mcpServers["test-mcp"]).toEqual({ command: "test-mcp", args: ["mcp-bridge"] });
  });

  it("register is idempotent — a second run leaves an already-correct .mcp.json untouched", async () => {
    await execFileAsync(process.execPath, [bin, "register"], { cwd: project, env });
    const before = fs.readFileSync(path.join(project, ".mcp.json"), "utf8");
    const { stdout } = await execFileAsync(process.execPath, [bin, "register"], { cwd: project, env });
    expect(stdout).toContain("MCP client config already present");
    expect(fs.readFileSync(path.join(project, ".mcp.json"), "utf8")).toBe(before);
  });

  it("register fails loudly instead of clobbering an unparsable .mcp.json", async () => {
    fs.writeFileSync(path.join(project, ".mcp.json"), "{ not valid json");
    await expect(
      execFileAsync(process.execPath, [bin, "register"], { cwd: project, env }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(".mcp.json is not valid JSON"),
    });
    // The bad file is left exactly as it was — never overwritten.
    expect(fs.readFileSync(path.join(project, ".mcp.json"), "utf8")).toBe("{ not valid json");
  });

  it("register --dir registers a vitest config that lives in a subfolder", async () => {
    // No config at the git root — only inside packages/foo — mirrors a monorepo layout.
    fs.rmSync(path.join(project, "vitest.config.ts"));
    const sub = path.join(project, "packages", "foo");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "vitest.config.ts"), "export default {};\n");

    const subReal = fs.realpathSync(sub);
    const { stdout } = await execFileAsync(
      process.execPath,
      [bin, "register", "--dir", "packages/foo"],
      { cwd: project, env },
    );
    expect(stdout).toContain("registered");
    expect(stdout).toContain(subReal);
    const reg = JSON.parse(fs.readFileSync(path.join(home, "registry.json"), "utf8"));
    const entries = Object.values(reg.projects) as Array<{ path: string }>;
    expect(entries.map((p) => p.path)).toContain(subReal);
  });

  it("register --dir rejects a path outside the git repository", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cli-outside-"));
    try {
      await expect(
        execFileAsync(
          process.execPath,
          [bin, "register", "--dir", outside, "--no-spawn"],
          { cwd: project, env },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("resolves outside the git repository"),
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
