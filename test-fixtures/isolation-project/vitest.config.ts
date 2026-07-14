import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    environment: "node",
    // isolate defaults to true — stated explicitly for the fixture's intent.
    isolate: true,
  },
});
