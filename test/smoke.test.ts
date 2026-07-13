import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION } from "../src/index.ts";

describe("scaffold", () => {
  it("exports SCHEMA_VERSION", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
