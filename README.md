# test-server-mcp

MCP (Model Context Protocol) server for intelligent test running.

## Overview

This project provides an MCP server that enables AI agents to programmatically run tests, query results, and receive intelligent recommendations about test execution strategy.

## Features

- **Multiple test runner support**: Vitest (first), Jest, pytest (future)
- **Incremental testing**: Only re-run tests affected by file changes
- **Coverage-aware**: Track which tests cover which files
- **Minimal output**: Focus on failures, not verbose logs
- **Status monitoring**: HTTP endpoint for human-readable test status

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure mcp.json (see docs/configuration.md)

# Run the server
pnpm start
```

## Documentation

- [PRD](docs/prd.md) - Product requirements
- [Patterns](docs/patterns.md) - Implementation patterns
- [Story Template](docs/story-template.md) - Story format

## Development

```bash
# Typecheck
pnpm typecheck

# Lint
pnpm lint

# Test
pnpm test
```

## Configuration

See `docs/configuration.md` for detailed configuration options.
