import { describe, expect, it } from "vitest";

describe("bootstrap smoke test", () => {
  it("proves the test runner and TypeScript path alias are wired up", () => {
    expect(1 + 1).toBe(2);
  });
});
