# Patterns

> All code below was validated against the current published APIs (July 2026):
> `@modelcontextprotocol/sdk` (TypeScript SDK v1, stable) and Vitest 3.2+ /
> 4.x `vitest/node`. Where an API is version-sensitive, it is called out inline.

## MCP Server Pattern

The server is a **persistent on-system daemon** managing multiple projects. Phase 1 uses
Streamable HTTP; an optional stdio mode serves a single project. The stable SDK exposes a
high-level `McpServer` from the `mcp.js` subpath. Note the `.js` suffix in import
specifiers — the package ships ESM subpath exports and the suffix is required even from
TypeScript.

### Daemon mode (Streamable HTTP) — primary

```typescript
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());

// One transport instance == one session; route later requests by Mcp-Session-Id.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (sid && transports.has(sid)) {
    return transports.get(sid)!.handleRequest(req, res, req.body);
  }
  if (!sid && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    const server = buildServer(); // McpServer with tools registered
    await server.connect(transport);
    return transport.handleRequest(req, res, req.body);
  }
  res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null });
});

// GET (notification stream) and DELETE (session teardown) route the same way.
app.get("/mcp", (req, res) => transports.get(req.headers["mcp-session-id"] as string)?.handleRequest(req, res));

app.listen(3000);
```

> If you use `StreamableHTTPServerTransport` directly (not the `@modelcontextprotocol/express`
> helper), you must implement Host/Origin header validation yourself.

### Single-project mode (stdio) — optional

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = buildServer();
await server.connect(new StdioServerTransport());
```

> stdio transport uses stdout for JSON-RPC. Never `console.log` to stdout from the
> server — write all diagnostics to stderr, or you will corrupt the protocol stream.

> A v2 SDK (`@modelcontextprotocol/server`) is in beta with a slightly different
> import surface (`@modelcontextprotocol/server`, `serveStdio`, `NodeStreamableHTTPServerTransport`).
> Phase 1 targets the stable v1 package unless we deliberately opt into v2.

## Tool Definition Pattern

Tools are registered with `registerTool`. The `inputSchema` is a Zod schema (a raw
shape object of Zod types); the SDK derives the JSON Schema the model sees, validates
arguments before the handler runs, and infers the handler's argument types. An
optional `outputSchema` enables structured results.

```typescript
import { z } from "zod";

server.registerTool(
  "run_tests",
  {
    title: "Run tests",
    description: "Run tests for the configured test suite",
    inputSchema: {
      projectId: z.string().describe("ID of a project registered via register_project"),
      suite: z.string().optional().describe("Test suite name (defaults to the project default)"),
      mode: z
        .enum(["full", "incremental", "watch"])
        .default("incremental")
        .describe("Run mode"),
      files: z
        .array(z.string())
        .optional()
        .describe("Specific files to run"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Compute the test plan without executing"),
    },
    outputSchema: {
      success: z.boolean(),
      total: z.number(),
      passed: z.number(),
      failed: z.number(),
    },
  },
  async ({ suite, mode, files, dryRun }) => {
    const result = await runSuite({ suite, mode, files, dryRun });
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
);
```

`registerTool` automatically advertises the tool during MCP capability negotiation
and emits `list_changed` notifications when tools are added, removed, enabled, or
disabled — there is no separate "list tools" handler to write.

## Project Registration & State Layout Pattern

A single daemon serves many projects. Agents register a project by path; the server
resolves and validates its vitest/vite config and records the registration in a
**central** registry. Per-project state lives **in the repo** at `<git-root>/.test-mcp/`
(git-ignored) so it is visible but not committed — not a black box.

```typescript
interface ProjectConfig {
  projectId: string;      // defaults to hash of the absolute path; pinnable in config.json
  stateDir: string;       // default "<git-root>/.test-mcp"
}

interface RegisteredProject extends ProjectConfig {
  path: string;           // absolute project root
  configPath: string;     // resolved vitest/vite config
  status: "idle" | "running" | "error";
}
```

State locations:

- **Per-project** (in the repo, git-ignored on init): `<git-root>/.test-mcp/config.json`
  (`projectId`, `stateDir`), the coverage map, and run history.
- **Daemon-global** (central, e.g. `~/.test-mcp/`): the project registry, `daemon.lock`
  (pid + port), never written inside a project.

```typescript
server.registerTool(
  "register_project",
  {
    title: "Register project",
    description: "Register a project (with a vitest/vite config) for test orchestration",
    inputSchema: { path: z.string().describe("Absolute path to the project root") },
    outputSchema: { projectId: z.string(), path: z.string(), status: z.string() },
  },
  async ({ path }) => {
    const project = await registerProject(path); // validate config, load/create .test-mcp/config.json, record in registry
    return {
      content: [{ type: "text", text: JSON.stringify(project) }],
      structuredContent: project,
    };
  },
);
// Companion tools: list_projects, unregister_project.
```

Every run/status tool takes a `projectId` and looks up the matching `RegisteredProject`.

## CLI Bootstrap Pattern

A thin `test-mcp` bin (safe to install globally or run via `npx` — it has no Vitest
coupling) bootstraps usage:

- `test-mcp init` — create `.test-mcp/config.json`; ensure `.test-mcp/` is in `.gitignore`.
- `test-mcp register` — run `init` if needed, ensure the singleton daemon is up
  (auto-boot locally; `--no-spawn` to require an already-running one in CI), then register
  the project. On failure to reach/boot the daemon, exit non-zero with a clear message so
  the agent bails and prompts the user.
- `test-mcp start | stop | status` — manage the singleton (lockfile-enforced).

## Per-Project Worker Execution Pattern

The daemon must run tests with the **project's own** Vitest, so it never imports
`vitest/node` into its own process. Instead it spawns a worker subprocess with
`cwd = projectRoot`; the worker resolves Vitest from the project's `node_modules` and runs
via the programmatic API. This isolates conflicting Vitest versions across projects and
keeps the daemon stable.

```typescript
import { fork } from "node:child_process";

function runInProject(project: RegisteredProject, args: RunArgs) {
  const worker = fork(require.resolve("./vitest-worker.js"), [], {
    cwd: project.path,                       // project CWD
    env: { ...process.env, TEST_MCP_STATE_DIR: project.stateDir },
  });
  worker.send({ type: "run", args });
  // worker imports the project-local `vitest/node`, runs, and posts results back over IPC
  return awaitWorkerResult(worker);
}
```

Inside `vitest-worker.js`, resolve Vitest relative to the project root so the project's
installed version/plugins are used:

```typescript
const { createRequire } = require("node:module");
const projectRequire = createRequire(process.cwd() + "/");
const { startVitest } = projectRequire("vitest/node");
```

## Result Formatting Pattern

Results are structured consistently and returned both as text (for clients that only
read `content`) and as `structuredContent` (validated against `outputSchema`):

```typescript
interface TestResult {
  success: boolean;
  duration: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{
    name: string;
    file: string;
    message: string;
    stack?: string;
  }>;
}
```

Follow progressive disclosure: `run_tests` returns counts plus a compact failure
list; a separate `get_failure_details` tool returns full stack/assertion data for a
single failure on request.

## Running Vitest Programmatically

Use the `vitest/node` advanced API rather than shelling out to the CLI. `startVitest`
initialises reporters and the coverage provider and runs immediately; `createVitest`
initialises without running so you can drive runs manually. In the daemon this code runs
inside the per-project worker (see Per-Project Worker Execution Pattern), resolving Vitest
from the project's own `node_modules`.

```typescript
import { startVitest } from "vitest/node";

// Run specific files with coverage.
const vitest = await startVitest(
  "test",
  files, // CLI-style filters (test file paths / patterns)
  {
    watch: false,
    coverage: { enabled: true, provider: "v8", all: false },
  },
);

const modules = vitest.state.getTestModules(); // structured results
await vitest.close();
```

> **Version note:** Vitest 4 removed the leading `mode` argument, so the signature
> becomes `startVitest(filters, options, ...)`. Pin the Vitest version and match the
> signature to it. `runTestFiles(filepaths, allTestsRun)` is available from Vitest
> 4.1+; on 3.x use `runTestSpecifications`.

For a long-lived server that reruns on demand, keep a `createVitest` instance alive
with `watch: true` and call `runTestSpecifications` / `rerunTestSpecifications`.

## Git-Aware Delta Selection Pattern

Vitest ships `--changed` (and `related`), which run test files affected by a git diff.
**Important limitation, verified against Vitest:** `--changed` walks only the *static*
import graph. It misses dependencies created at runtime (dynamic `import()`, DI
containers, service registries) and does not persist a map across runs. Treat it as a
fast first pass, and always fall back to the full suite when a changed file is unknown
to the map.

```typescript
const vitest = await startVitest("test", [], {
  changed: true, // git-diff based, static-import graph
  watch: false,
});
```

## Coverage-to-Test Mapping Pattern

The smart-rerun feature needs a reverse map of *source file → test files that exercise
it*. **This is not produced by a standard coverage report** (which reports aggregate
file coverage, not per-test attribution) and is not something `--changed` gives us.

The validated technique (used by tools such as `testpick` and `vitest-affected`) is to
build the map from **runtime** coverage:

1. Run test files with V8 precise coverage enabled.
2. Snapshot cumulative coverage after each test file completes.
3. Diff each snapshot against the previous one — whatever coverage increased was
   exercised by that test file.
4. Persist the resulting map; re-measure only changed/new test files incrementally.

```typescript
interface CoverageMap {
  // sourceFilePath -> test files that executed it at least once
  [sourceFilePath: string]: {
    tests: string[];
    lastMeasured: string; // ISO timestamp / content hash
  };
}
```

Granularity is **test-file level**, not individual test case. Because the map reflects
what a recorded run *executed*, it can miss a not-yet-exercised branch; the static
graph can catch those. The two are complementary, so the safe default is to union
both selections and err toward running more.

## Status & Streaming Pattern

MCP `tools/call` is fundamentally request/response. Live per-test streaming to the
*tool caller* is still experimental in the spec (partial-results-over-progress
notifications are proposal-stage). For Phase 1:

- Use `notifications/progress` (with a `progressToken`) for coarse status/progress
  while a run executes; the final `tools/call` response remains authoritative.
- Expose a `get_test_status` tool returning `idle | running | complete | error` plus
  the latest results for polling.
- Reserve true real-time streaming (per-test-as-it-finishes) for the **Layer 2 HTTP
  UI via SSE/WebSocket**, which is the appropriate transport for push updates — not
  the MCP stdio channel.
