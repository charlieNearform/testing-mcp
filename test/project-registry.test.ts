import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ProjectRegistry,
  RegistryError,
  computeProjectId,
} from "../src/registry/project-registry.ts";

let tmp: string;
let projectDir: string;
let registryFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-reg-"));
  projectDir = path.join(tmp, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "vitest.config.ts"), "export default {};\n");
  registryFile = path.join(tmp, "central", "registry.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ProjectRegistry", () => {
  it("registers a project with a valid config and persists registry.json", async () => {
    const reg = new ProjectRegistry(registryFile);
    const summary = await reg.register(projectDir);
    expect(summary.projectId).toBe(computeProjectId(projectDir));
    expect(summary.path).toBe(path.resolve(projectDir));
    expect(summary.status).toBe("idle");
    expect(reg.has(summary.projectId)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    expect(onDisk.schemaVersion).toBe(1);
    expect(Object.keys(onDisk.projects)).toContain(summary.projectId);
  });

  it("rejects a directory with no vitest/vite config (InvalidConfig)", async () => {
    const reg = new ProjectRegistry(registryFile);
    const noConfig = path.join(tmp, "empty");
    fs.mkdirSync(noConfig);
    await expect(reg.register(noConfig)).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  it("lists and unregisters projects; unknown id throws UnknownProject", async () => {
    const reg = new ProjectRegistry(registryFile);
    const { projectId } = await reg.register(projectDir);
    expect(await reg.list()).toHaveLength(1);
    const removed = await reg.unregister(projectId);
    expect(removed).toEqual({ projectId, removed: true });
    expect(await reg.list()).toHaveLength(0);
    await expect(reg.unregister("nope")).rejects.toBeInstanceOf(RegistryError);
  });

  it("load() rehydrates from an existing registry.json", async () => {
    const first = new ProjectRegistry(registryFile);
    const { projectId } = await first.register(projectDir);
    const second = new ProjectRegistry(registryFile);
    expect(second.has(projectId)).toBe(false); // not loaded yet
    await second.load();
    expect(second.has(projectId)).toBe(true);
  });
});
