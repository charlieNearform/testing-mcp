import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("cli-main", () => {
  let helpOutput: string;

  beforeAll(async () => {
    const { stdout } = await execFileAsync("node", ["bin/test-mcp.mjs", "--help"]);
    helpOutput = stdout;
  });

  it("prints usage with --help", async () => {
    expect(helpOutput).toContain("test-mcp");
    expect(helpOutput).toContain("start");
  });
});
