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
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile("node", [binPath, ...args], { cwd, env }, (error, stdout) => {
      resolve({ stdout: stdout ?? "", code: error ? ((error as { code?: number }).code ?? 1) : 0 });
    });
  });
}

describe("cli mcp-config", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("prints both a local-scope command and a committed-safe .mcp.json snippet", async () => {
    // TEST_MCP_TOKEN pins the token; cwd is a non-git temp dir so no project note is added.
    const { code, stdout } = await runCli(
      ["mcp-config"],
      { ...process.env, TEST_MCP_HOME: home, TEST_MCP_TOKEN: "demo-token-123" },
      home,
    );
    expect(code).toBe(0);
    // Daemon URL with the default port.
    expect(stdout).toContain("http://127.0.0.1:7420/mcp");
    // Option A: local-scope claude command carrying the real token.
    expect(stdout).toContain("claude mcp add --transport http --scope local test-mcp");
    expect(stdout).toContain("Authorization: Bearer demo-token-123");
    // Option B: committed-safe config references the env var, NOT the literal token.
    expect(stdout).toContain('"Authorization": "Bearer ${TEST_MCP_TOKEN}"');
    expect(stdout).toContain("export TEST_MCP_TOKEN=demo-token-123");
  });
});
