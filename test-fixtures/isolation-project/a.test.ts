import { test, expect } from "vitest";
import { increment } from "./counter.ts";

test("file A sees a fresh counter", () => {
  expect(increment()).toBe(1);
});
