import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectRegistry, RegistryError } from "../src/registry/project-registry.ts";

let tmp: string;
let registryFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-mig-"));
  registryFile = path.join(tmp, "registry.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const entry = { path: "/some/project", configPath: "/some/project/vitest.config.ts", status: "idle" };

describe("registry migration + rehydration", () => {
  it("loads a current-version file", async () => {
    fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, projects: { abc: entry } }));
    const reg = new ProjectRegistry(registryFile);
    await reg.load();
    expect(reg.has("abc")).toBe(true);
    expect(await reg.list()).toHaveLength(1);
  });

  it("migrates a legacy (pre-versioning) file forward and re-persists it", async () => {
    // No schemaVersion field => treated as version 0 and stamped to current.
    fs.writeFileSync(registryFile, JSON.stringify({ projects: { abc: entry } }));
    const reg = new ProjectRegistry(registryFile);
    await reg.load();
    expect(reg.has("abc")).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    expect(onDisk.schemaVersion).toBe(1); // upgraded file was re-saved
  });

  it("rejects a newer schemaVersion with a clear InvalidConfig error", async () => {
    fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 99, projects: {} }));
    const reg = new ProjectRegistry(registryFile);
    await expect(reg.load()).rejects.toMatchObject({ code: "InvalidConfig" });
    await expect(reg.load()).rejects.toBeInstanceOf(RegistryError);
  });

  it("rejects a corrupt (non-JSON) file with InvalidConfig", async () => {
    fs.writeFileSync(registryFile, "{ this is not json");
    const reg = new ProjectRegistry(registryFile);
    await expect(reg.load()).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  it("is a no-op when no registry file exists", async () => {
    const reg = new ProjectRegistry(registryFile);
    await expect(reg.load()).resolves.toBeUndefined();
    expect(await reg.list()).toHaveLength(0);
  });
});
