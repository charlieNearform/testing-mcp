import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SCHEMA_VERSION } from "../index.js";
import type { ErrorCode } from "../types/errors.js";

export type ProjectStatus = "idle" | "running" | "error";

export interface RegisteredProject {
  projectId: string;
  path: string;
  configPath: string;
  status: ProjectStatus;
}

export interface RegistrySummary {
  projectId: string;
  path: string;
  status: ProjectStatus;
}

/** Thrown for expected, structured failures the MCP layer maps to an error envelope. */
export class RegistryError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Deterministic projectId: first 16 hex chars of sha256(absolute path). */
export function computeProjectId(projectPath: string): string {
  const abs = path.resolve(projectPath);
  return crypto.createHash("sha256").update(abs).digest("hex").slice(0, 16);
}

const VITEST_CONFIG_NAMES = [
  "vitest.config.ts", "vitest.config.mts", "vitest.config.cts",
  "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs",
  "vite.config.ts", "vite.config.mts", "vite.config.cts",
  "vite.config.js", "vite.config.mjs", "vite.config.cjs",
];

/** Return the resolved vitest/vite config path, or throw InvalidConfig if none exists. */
export function resolveVitestConfig(projectPath: string): string {
  const abs = path.resolve(projectPath);
  for (const name of VITEST_CONFIG_NAMES) {
    const candidate = path.join(abs, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new RegistryError(
    "InvalidConfig",
    `No vitest/vite config found at ${abs} (looked for ${VITEST_CONFIG_NAMES.join(", ")})`,
  );
}

interface RegistryFile {
  schemaVersion: number;
  projects: Record<string, { path: string; configPath: string; status: ProjectStatus }>;
}

export class ProjectRegistry {
  private projects = new Map<string, RegisteredProject>();

  /** @param registryPath absolute path to registry.json (injected so tests stay hermetic). */
  constructor(private readonly registryPath: string) {}

  has(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  /** Read registry.json into memory if it exists. (Daemon-start rehydration is wired in Story 1.4.) */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.registryPath, "utf8");
    } catch {
      return; // no file yet
    }
    const parsed = JSON.parse(raw) as RegistryFile;
    this.projects.clear();
    for (const [projectId, entry] of Object.entries(parsed.projects ?? {})) {
      this.projects.set(projectId, { projectId, ...entry });
    }
  }

  async save(): Promise<void> {
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const file: RegistryFile = { schemaVersion: SCHEMA_VERSION, projects: {} };
    for (const [projectId, p] of this.projects) {
      file.projects[projectId] = { path: p.path, configPath: p.configPath, status: p.status };
    }
    fs.writeFileSync(this.registryPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.chmodSync(this.registryPath, 0o600);
  }

  /** Validate the path has a vitest/vite config, record it, persist, and return a summary. */
  async register(projectPath: string): Promise<RegistrySummary> {
    const abs = path.resolve(projectPath);
    const configPath = resolveVitestConfig(abs); // throws InvalidConfig if none

    // Prefer the projectId written by `test-mcp init/register` into the repo config; else derive it.
    let projectId = computeProjectId(abs);
    try {
      const repoCfg = JSON.parse(
        fs.readFileSync(path.join(abs, ".test-mcp", "config.json"), "utf8"),
      ) as { projectId?: string };
      if (repoCfg.projectId) projectId = repoCfg.projectId;
    } catch {
      // no repo config — derived id is fine
    }

    const project: RegisteredProject = { projectId, path: abs, configPath, status: "idle" };
    this.projects.set(projectId, project);
    await this.save();
    return { projectId, path: abs, status: project.status };
  }

  async list(): Promise<RegistrySummary[]> {
    return [...this.projects.values()].map((p) => ({
      projectId: p.projectId,
      path: p.path,
      status: p.status,
    }));
  }

  async unregister(projectId: string, purge = false): Promise<{ projectId: string; removed: true }> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new RegistryError("UnknownProject", `Project not registered: ${projectId}`);
    }
    this.projects.delete(projectId);
    await this.save();
    if (purge) {
      fs.rmSync(path.join(project.path, ".test-mcp"), { recursive: true, force: true });
    }
    return { projectId, removed: true };
  }
}
