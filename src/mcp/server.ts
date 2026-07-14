import { randomUUID } from "node:crypto";
import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse, RequestListener } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { toAppError, type AppError } from "../types/errors.js";
import { ProjectRegistry, RegistryError } from "../registry/project-registry.js";

export interface McpServerDeps {
  /** Shared project registry (owned by the daemon). Absent in bare unit tests. */
  registry?: ProjectRegistry;
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
  const isRegistered = (projectId: string) => registry?.has(projectId) ?? false;
  const server = new McpServer({ name: "test-mcp", version: "0.0.0" });

  const unknownProject = (projectId: string) =>
    errorResult(toAppError("UnknownProject", `Project not registered: ${projectId}`));

  const requireRegisteredProject = (projectId: string) => {
    if (!isRegistered(projectId)) return unknownProject(projectId);
    return errorResult(
      toAppError("NotImplemented", "Project-scoped tool execution arrives in later stories"),
    );
  };

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
        files: z.array(z.string()).optional().describe("Specific files to run"),
        suite: z.string().optional().describe("Test suite name"),
        dryRun: z.boolean().optional().describe("Compute the plan without executing"),
        planId: z.string().optional().describe("Execute a previously computed plan"),
      },
    },
    async ({ projectId }) => requireRegisteredProject(projectId),
  );

  server.registerTool(
    "get_test_status",
    {
      description: "Get the current test run state for a project",
      inputSchema: { projectId: z.string().describe("ID of a registered project") },
    },
    async ({ projectId }) => requireRegisteredProject(projectId),
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
    async ({ projectId }) => requireRegisteredProject(projectId),
  );

  return server;
}

// --- HTTP security helpers -------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.replace(/:\d+$/, "").toLowerCase(); // strip :port ("127.0.0.1:7420" -> "127.0.0.1"; "[::1]:7420" -> "[::1]")
  return LOOPBACK_HOSTS.has(bare);
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients omit Origin
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host);
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
