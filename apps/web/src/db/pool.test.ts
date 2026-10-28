import { describe, expect, it, vi } from "vitest";
import { createDb, poolMax } from "./index";

describe("poolMax (DB_POOL_MAX)", () => {
  it("defaults to 10 when unset or empty", () => {
    expect(poolMax(undefined)).toBe(10);
    expect(poolMax("")).toBe(10);
  });

  it("reads a positive integer", () => {
    expect(poolMax("20")).toBe(20);
    expect(poolMax(" 5 ")).toBe(5);
  });

  it("ignores garbage, zero, negatives, fractions and absurd sizes (falls back to 10)", () => {
    for (const bad of ["abc", "0", "-3", "2.5", "1e3", "10000"]) expect(poolMax(bad)).toBe(10);
  });

  it("warns about an invalid value before falling back, never about unset or valid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    poolMax(undefined);
    poolMax("20");
    expect(warn).not.toHaveBeenCalled();
    poolMax("abc");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("DB_POOL_MAX");
    warn.mockRestore();
  });

  it("the pool uses the given size (postgres-js options.max); no connection is opened", async () => {
    const { sql, close } = createDb("postgres://u@localhost:1/x", { max: 7 });
    expect(sql.options.max).toBe(7);
    await close();
  });
});
