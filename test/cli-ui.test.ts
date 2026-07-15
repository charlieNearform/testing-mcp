import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(repoRoot, "bin", "test-mcp.mjs");

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("node", [binPath, ...args], { cwd, env }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
      });
    });
  });
}

describe("cli ui", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-ui-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("prints just the UI URL on stdout (pipeable)", async () => {
    const { code, stdout, stderr } = await runCli(
      ["ui"],
      { ...process.env, TEST_MCP_HOME: home },
      home,
    );
    expect(code).toBe(0);
    // stdout is exactly the URL so `open "$(test-mcp ui)"` works.
    expect(stdout.trim()).toBe("http://127.0.0.1:7420/ui");
    // The "daemon not running" hint goes to stderr, not stdout.
    expect(stderr).toContain("daemon not running");
  });
});
