import { describe, expect, it } from "vitest";
import { seal, unseal } from "./seal";

const A = "a".repeat(32);
const B = "b".repeat(32);

describe("seal", () => {
  it("round-trips and is URL-safe", () => {
    const s = seal({ x: 1 }, [A], null);
    expect(s).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(unseal(s, [A], 1_790_000_000_000)).toEqual({ x: 1 });
  });

  it("opens with any secret in the list (rotation), the first seals", () => {
    expect(unseal(seal("old", [B], null), [A, B], 0)).toBe("old");
    expect(unseal(seal("new", [A, B], null), [A], 0)).toBe("new");
  });

  it("null when expired, tampered, unknown key or malformed", () => {
    const s = seal("v", [A], 1000);
    expect(unseal(s, [A], 999)).toBe("v");
    expect(unseal(s, [A], 1000)).toBeNull();
    expect(unseal(s, [B], 0)).toBeNull();
    const parts = s.split(".");
    const ct = Buffer.from(parts[2], "base64url");
    ct[0] ^= 1;
    expect(unseal([parts[0], parts[1], ct.toString("base64url")].join("."), [A], 0)).toBeNull();
    expect(unseal("nope", [A], 0)).toBeNull();
  });
});
