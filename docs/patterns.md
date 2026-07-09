# Patterns

## MCP Server Pattern

The MCP server uses a standard pattern:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";

const server = new Server(
  {
    name: "test-runner",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler("tools/call", async (request) => {
  // Handle tool calls
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Tool Definition Pattern

Tools are defined with strict schemas:

```typescript
const RUN_TESTS_TOOL = {
  name: "run_tests",
  description: "Run tests for the configured test suite",
  inputSchema: {
    type: "object",
    properties: {
      suite: { type: "string", description: "Test suite name" },
      mode: { 
        type: "string", 
        enum: ["full", "incremental", "watch"],
        description: "Run mode"
      },
      files: { 
        type: "array", 
        items: { type: "string" },
        description: "Specific files to run"
      }
    },
    required: ["suite"]
  }
};
```

## Result Formatting Pattern

Results should be structured consistently:

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
    message: string;
    stack?: string;
  }>;
}
```

## File Change Detection Pattern

Use Vitest's built-in change detection:

```typescript
import { resolveConfig } from 'vitest';
import { FileChange, getWatcher } from 'vite';

const config = await resolveConfig({}, 'test');
const watcher = getWatcher(config);

watcher.on('change', (filePath) => {
  // Determine affected tests
});
```

## Coverage Mapping Pattern

Parse coverage reports to build file-to-test mappings:

```typescript
interface CoverageMap {
  [filePath: string]: {
    covered: boolean;
    tests: string[];
  };
}
```
