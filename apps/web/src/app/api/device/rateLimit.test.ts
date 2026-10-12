import { describe, expect, it } from "vitest";
import { rateLimiter } from "./rateLimit";

describe("rateLimiter", () => {
  it("allows up to the limit per key per window, then returns seconds to wait", () => {
    const hit = rateLimiter(2, 60_000);
    expect(hit("a", 0)).toBeNull();
    expect(hit("a", 1_000)).toBeNull();
    expect(hit("a", 2_000)).toBe(58);
    expect(hit("b", 2_000)).toBeNull();
  });

  it("opens again when the window has passed", () => {
    const hit = rateLimiter(1, 60_000);
    expect(hit("a", 0)).toBeNull();
    expect(hit("a", 59_999)).toBe(1);
    expect(hit("a", 60_000)).toBeNull();
  });
});
