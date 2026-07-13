import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  // Coverage configuration added in Story 1.2
  // For now, enable coverage provider without thresholds
  coverage: {
    enabled: false,
    provider: "v8",
  },
});
