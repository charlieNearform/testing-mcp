import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(repoRoot, "bin", "test-mcp.mjs");

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("node", [binPath, ...args], { cwd: repoRoot }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
      });
    });
  });
}

describe("cli link/unlink", () => {
  let dir: string;
  const linkPath = (): string => path.join(dir, "test-mcp");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-link-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("links the CLI into the target dir as a symlink to the package bin", async () => {
    const { code, stdout } = await runCli(["link", "--dir", dir]);
    expect(code).toBe(0);
    expect(stdout).toContain(`linked -> ${linkPath()}`);
    expect(fs.lstatSync(linkPath()).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath())).toBe(fs.realpathSync(binPath));
  });

  it("produces a runnable symlink", async () => {
    await runCli(["link", "--dir", dir]);
    const out = await new Promise<string>((resolve) => {
      execFile(linkPath(), ["--version"], (_e, stdout) => resolve(stdout ?? ""));
    });
    expect(out.trim()).toBe("0.0.0");
  });

  it("is idempotent when already linked", async () => {
    await runCli(["link", "--dir", dir]);
    const { code, stdout } = await runCli(["link", "--dir", dir]);
    expect(code).toBe(0);
    expect(stdout).toContain("already linked");
  });

  it("refuses to overwrite an existing entry without --force", async () => {
    fs.writeFileSync(linkPath(), "not ours");
    const { code, stderr } = await runCli(["link", "--dir", dir]);
    expect(code).toBe(1);
    expect(stderr).toContain("already exists");
    expect(fs.readFileSync(linkPath(), "utf8")).toBe("not ours"); // untouched
  });

  it("overwrites with --force", async () => {
    fs.writeFileSync(linkPath(), "not ours");
    const { code } = await runCli(["link", "--dir", dir, "--force"]);
    expect(code).toBe(0);
    expect(fs.lstatSync(linkPath()).isSymbolicLink()).toBe(true);
  });

  it("unlinks a symlink it created", async () => {
    await runCli(["link", "--dir", dir]);
    const { code, stdout } = await runCli(["unlink", "--dir", dir]);
    expect(code).toBe(0);
    expect(stdout).toContain("removed");
    expect(fs.existsSync(linkPath())).toBe(false);
  });

  it("refuses to unlink a real file", async () => {
    fs.writeFileSync(linkPath(), "a real binary");
    const { code, stderr } = await runCli(["unlink", "--dir", dir]);
    expect(code).toBe(1);
    expect(stderr).toContain("not a symlink");
    expect(fs.existsSync(linkPath())).toBe(true); // preserved
  });
});
