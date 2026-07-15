import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectRegistry, RegistryError } from "../src/registry/project-registry.ts";
import { SCHEMA_VERSION } from "../src/index.ts";

describe("registry.json validation & atomic write", () => {
  let dir: string;
  let registryPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-reg-"));
    registryPath = path.join(dir, "registry.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a registry with a malformed project entry", async () => {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        projects: { p1: { path: "/x" } }, // missing configPath + status
      }),
    );
    const reg = new ProjectRegistry(registryPath);
    await expect(reg.load()).rejects.toBeInstanceOf(RegistryError);
  });

  it("rejects a registry whose projects field is the wrong type", async () => {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, projects: "nope" }),
    );
    const reg = new ProjectRegistry(registryPath);
    await expect(reg.load()).rejects.toBeInstanceOf(RegistryError);
  });

  it("does not leave a .tmp file behind after saving", async () => {
    const reg = new ProjectRegistry(registryPath);
    // register requires a real vitest config; instead exercise save() via load of a valid file
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 0, // pre-versioned -> triggers an upgrade + re-save
        projects: { p1: { path: "/x", configPath: "/x/vitest.config.ts", status: "idle" } },
      }),
    );
    await reg.load(); // upgrades and re-persists atomically
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
    expect(reg.has("p1")).toBe(true);
  });
});
