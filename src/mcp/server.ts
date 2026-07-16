import { randomUUID } from "node:crypto";
import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse, RequestListener } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { toAppError, type AppError } from "../types/errors.js";
import { ProjectRegistry, RegistryError } from "../registry/project-registry.js";
import { Orchestrator, PlanError } from "../orchestrator/index.js";
import { WatchManager } from "../watch/index.js";
import { handleUiRequest } from "../ui/index.js";

export interface McpServerDeps {
  /** Shared project registry (owned by the daemon). Absent in bare unit tests. */
  registry?: ProjectRegistry;
  /** Test-run orchestrator (owned by the daemon). Absent in bare unit tests. */
  orchestrator?: Orchestrator;
  /** Watch/incremental mode manager (owned by the daemon). Absent in bare unit tests. */
  watchManager?: WatchManager;
}

export interface McpListenerDeps extends McpServerDeps {
  /** Per-daemon bearer token (from the lockfile). Required for /mcp auth. */
  token: string;
}

function errorResult(err: AppError) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(err) }] };
}

/** Build a configured McpServer with all Phase-1 tools registered (discoverable). */
export function createMcpServer(deps: McpServerDeps = {}): McpServer {
  const registry = deps.registry;
  const orchestrator = deps.orchestrator;
  const watchManager = deps.watchManager;
  const isRegistered = (projectId: string) => registry?.has(projectId) ?? false;
  const server = new McpServer({ name: "test-mcp", version: "0.0.0" });

  const unknownProject = (projectId: string) =>
    errorResult(toAppError("UnknownProject", `Project not registered: ${projectId}`));

  server.registerTool(
    "register_project",
    {
      description: "Register a project (with a vitest/vite config) for test orchestration",
      inputSchema: { path: z.string().describe("Absolute path to the project root") },
    },
    async ({ path: projectPath }) => {
      if (!registry) return errorResult(toAppError("NotImplemented", "registry unavailable"));
      try {
        const project = await registry.register(projectPath);
        return { content: [{ type: "text" as const, text: JSON.stringify(project) }] };
      } catch (e) {
        if (e instanceof RegistryError) return errorResult(toAppError(e.code, e.message));
        const message = e instanceof Error ? e.message : String(e);
        return errorResult(toAppError("ValidationError", message));
      }
    },
  );

  server.registerTool(
    "list_projects",
    { description: "List registered projects", inputSchema: {} },
    async () => {
      const projects = registry ? await registry.list() : [];
      return { content: [{ type: "text" as const, text: JSON.stringify({ projects }) }] };
    },
  );

  server.registerTool(
    "unregister_project",
    {
      description: "Remove a project from the active registry",
      inputSchema: {
        projectId: z.string().describe("ID of a registered project"),
        purge: z.boolean().optional().describe("Also delete the project's .test-mcp state"),
      },
    },
    async ({ projectId, purge }) => {
      if (!registry || !registry.has(projectId)) return unknownProject(projectId);
      try {
        const result = await registry.unregister(projectId, purge ?? false);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        if (e instanceof RegistryError) return errorResult(toAppError(e.code, e.message));
        const message = e instanceof Error ? e.message : String(e);
        return errorResult(toAppError("ValidationError", message));
      }
    },
  );

  server.registerTool(
    "run_tests",
    {
      description: "Run tests for a registered project",
      inputSchema: {
        projectId: z.string().describe("ID of a registered project"),
        mode: z.enum(["full", "incremental", "watch"]).optional().describe("Run mode"),
        coverage: z
          .boolean()
          .optional()
          .describe(
            "Build/refresh the source->test coverage map for this run. If omitted, defaults to " +
              "true once the project already has a coverage map (pass false to opt out for this " +
              "run), otherwise defaults to false until first enabled.",
          ),
        files: z.array(z.string()).optional().describe("Specific files to run"),
        since: z
          .enum(["last-run", "head"])
          .optional()
          .describe("Incremental baseline: 'last-run' (default) diffs vs the last run, 'head' vs git HEAD"),
        strict: z
          .boolean()
          .optional()
          .describe(
            "Force a full suite on any unmapped-source uncertainty (old behaviour) instead of a bounded run with degraded confidence",
          ),
        suite: z.string().optional().describe("Test suite name"),
        dryRun: z.boolean().optional().describe("Compute the plan without executing"),
        planId: z.string().optional().describe("Execute a previously computed plan"),
      },
    },
    async ({ projectId, files, mode, coverage, since, strict, dryRun, planId }, extra) => {
      const project = registry?.get(projectId);
      if (!project) return unknownProject(projectId);
      if (!orchestrator) {
        return errorResult(toAppError("NotImplemented", "orchestrator unavailable"));
      }
      // Forward per-file progress as notifications/progress when the client supplied a token (Story 4.2).
      const progressToken = extra?._meta?.progressToken;
      const onProgress =
        progressToken != null
          ? (completed: number, total: number) => {
              void extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress: completed, total },
              });
            }
          : undefined;
      try {
        if (dryRun) {
          const plan = orchestrator.plan(project, { files, mode, since, strict });
          return { content: [{ type: "text" as const, text: JSON.stringify(plan) }] };
        }
        const result = planId
          ? await orchestrator.runPlan(project, planId, { onProgress })
          : await orchestrator.runTests(project, { files, mode, coverage, since, strict, onProgress });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof PlanError) return errorResult(toAppError("PlanExpired", err.message));
        return errorResult(
          toAppError("WorkerFailure", err instanceof Error ? err.message : String(err)),
        );
      }
    },
  );

  server.registerTool(
    "get_test_status",
    {
      description: "Get the current test/watch state for a project",
      inputSchema: { projectId: z.string().describe("ID of a registered project") },
    },
    async ({ projectId }) => {
      if (!isRegistered(projectId)) return unknownProject(projectId);
      // Run state (Story 4.2) plus watch state (Story 3.6) — a single pollable snapshot.
      const run = orchestrator?.getRunStatus(projectId) ?? { state: "idle" as const };
      const watch = watchManager?.status(projectId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...run, watch }) }] };
    },
  );

  server.registerTool(
    "start_watch",
    {
      description: "Start watch mode: re-run affected tests as files change (poll get_test_status)",
      inputSchema: {
        projectId: z.string().describe("ID of a registered project"),
        fastMode: z
          .boolean()
          .optional()
          .describe("Skip coverage for speed (default true); set false to refresh the coverage map"),
      },
    },
    async ({ projectId, fastMode }) => {
      const project = registry?.get(projectId);
      if (!project) return unknownProject(projectId);
      if (!watchManager) return errorResult(toAppError("NotImplemented", "watch unavailable"));
      const status = watchManager.start(project, { fastMode });
      return { content: [{ type: "text" as const, text: JSON.stringify(status) }] };
    },
  );

  server.registerTool(
    "stop_watch",
    {
      description: "Stop watch mode for a project",
      inputSchema: { projectId: z.string().describe("ID of a registered project") },
    },
    async ({ projectId }) => {
      if (!isRegistered(projectId)) return unknownProject(projectId);
      if (!watchManager) return errorResult(toAppError("NotImplemented", "watch unavailable"));
      const stopped = watchManager.stop(projectId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ stopped }) }] };
    },
  );

  server.registerTool(
    "get_failure_details",
    {
      description: "Get the stack trace and assertion detail for a single failure",
      inputSchema: {
        projectId: z.string().describe("ID of a registered project"),
        failureId: z.string().describe("ID of a failure from a run result"),
      },
    },
    async ({ projectId, failureId }) => {
      const project = registry?.get(projectId);
      if (!project) return unknownProject(projectId);
      if (!orchestrator) {
        return errorResult(toAppError("NotImplemented", "orchestrator unavailable"));
      }
      const detail = orchestrator.getFailureDetail(projectId, failureId);
      if (!detail) {
        return errorResult(
          toAppError("ValidationError", `Unknown or expired failureId: ${failureId}`),
        );
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(detail) }] };
    },
  );

  return server;
}

// --- HTTP security helpers -------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Lower-case, strip an optional :port, and unwrap IPv6 brackets for loopback comparison. */
function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    // Bracketed IPv6, optionally "[::1]:7420" -> "::1".
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h.slice(1);
  }
  return h.replace(/:\d+$/, ""); // "127.0.0.1:7420" -> "127.0.0.1"
}

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients omit Origin
  try {
    return LOOPBACK_HOSTS.has(normalizeHost(new URL(origin).hostname));
  } catch {
    return false;
  }
}

function bearerOk(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Build the daemon's HTTP request listener: preserves the health route, enforces
 * Host/Origin/bearer security, and routes /mcp to a per-session Streamable HTTP transport.
 */
export function createMcpRequestListener(deps: McpListenerDeps): RequestListener {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0];

      // Security gate (applies to all requests) — Host/Origin first (DNS-rebinding defense).
      if (!hostAllowed(req.headers.host)) {
        return sendJson(res, 403, toAppError("ValidationError", "Host not allowed"));
      }
      if (!originAllowed(req.headers.origin as string | undefined)) {
        return sendJson(res, 403, toAppError("ValidationError", "Origin not allowed"));
      }

      // Health route — no auth (preserves Story 1.1 behaviour).
      if (method === "GET" && (path === "/" || path === "/health")) {
        return sendJson(res, 200, { status: "ok", daemon: "test-mcp" });
      }

      // Human Monitoring UI (Epic 5) — loopback-gated, GET-only, no bearer (like /health).
      if (path === "/ui" || path.startsWith("/ui/")) {
        const handled = await handleUiRequest(req, res, {
          registry: deps.registry,
          orchestrator: deps.orchestrator,
        });
        if (handled) return;
      }

      if (path !== "/mcp") {
        return sendJson(res, 404, toAppError("ValidationError", "Not found"));
      }

      // Bearer auth for all /mcp requests.
      if (!bearerOk(req.headers.authorization, deps.token)) {
        return sendJson(res, 401, toAppError("ValidationError", "Missing or invalid bearer token"));
      }

      const sid = req.headers["mcp-session-id"] as string | undefined;

      if (method === "POST") {
        const body = await readJsonBody(req);
        if (sid && transports.has(sid)) {
          await transports.get(sid)!.handleRequest(req, res, body);
          return;
        }
        if (!sid && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
            },
          });
          const server = createMcpServer(deps);
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
            void server.close();
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        return sendJson(res, 400, toAppError("ValidationError", "No valid session"));
      }

      if (method === "GET" || method === "DELETE") {
        if (sid && transports.has(sid)) {
          await transports.get(sid)!.handleRequest(req, res);
          return;
        }
        return sendJson(res, 400, toAppError("ValidationError", "No valid session"));
      }

      return sendJson(res, 405, toAppError("ValidationError", "Method not allowed"));
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof SyntaxError ? 400 : 500;
        sendJson(res, status, toAppError("ValidationError", message));
      }
    }
  };
}
