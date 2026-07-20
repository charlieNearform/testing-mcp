import { describe, it, expect } from "vitest";

// A fixed, deterministic delay -- long enough that a small `waitMs`/`defaultRunWaitMs` forces
// the async job-handle path, short enough to keep the suite fast. Dedicated to test/epic-8-e2e-smoke.test.ts
// so it never contends with other test files over test-fixtures/sample-project's shared state.
describe("live smoke", () => {
  it("passes after a fixed delay", async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(1 + 1).toBe(2);
  });
});
