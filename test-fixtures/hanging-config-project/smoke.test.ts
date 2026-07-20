import { describe, it, expect } from "vitest";

// Never reached -- vitest.config.ts's config-discovery hang means this test never runs.
describe("hanging config", () => {
  it("never gets here", () => {
    expect(1).toBe(1);
  });
});
