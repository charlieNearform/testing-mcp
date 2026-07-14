import { test, expect } from "vitest";
import { increment } from "./counter.ts";

test("file B sees a fresh counter (no leak from file A)", () => {
  expect(increment()).toBe(1);
});
