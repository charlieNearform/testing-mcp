#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const main = pathToFileURL(join(here, "..", "dist", "cli", "main.js")).href;

try {
  await import(main);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
    console.error("Error: dist/cli/main.js not found. Run `pnpm build` first.");
    process.exit(1);
  }
  throw error;
}
