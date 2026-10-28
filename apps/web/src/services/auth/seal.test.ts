import { describe, expect, it } from "vitest";
import { seal, unseal } from "./seal";

const A = "first-secret-at-least-32-characters-long";
const B = "second-secret-at-least-32-characters-long";
const NOW = 1_760_000_000_000;

/** Changes the second-to-last character of the ciphertext (always a different one, decided by that character). */
function tamper(sealed: string): string {
  const [k, iv, ct] = sealed.split(".");
  const at = ct.length - 2;
  return `${k}.${iv}.${ct.slice(0, at)}${ct[at] === "A" ? "B" : "A"}${ct.slice(at + 1)}`;
}

describe("seal / unseal", () => {
  it("round-trips a payload, URL-safe", () => {
    const s = seal({ a: 1, b: ["x"] }, [A], NOW + 1000);
    expect(s).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(unseal(s, [A], NOW)).toEqual({ a: 1, b: ["x"] });
  });

  it("is randomised (same payload, different output)", () => {
    expect(seal("x", [A], null)).not.toBe(seal("x", [A], null));
  });

  it("expires at expiresAt; null never expires", () => {
    const s = seal("x", [A], NOW);
    expect(unseal(s, [A], NOW - 1)).toBe("x");
    expect(unseal(s, [A], NOW)).toBeNull();
    expect(unseal(seal("y", [A], null), [A], Number.MAX_SAFE_INTEGER)).toBe("y");
  });

  it("opens with any listed secret, seals with the first (rotation)", () => {
    const old = seal("x", [B], null);
    expect(unseal(old, [A, B], NOW)).toBe("x");
    const fresh = seal("y", [A, B], null);
    expect(unseal(fresh, [A], NOW)).toBe("y");
    expect(unseal(fresh, [B], NOW)).toBeNull();
  });

  it("tamper() changes the text for every possible character, so a tamper test can never be a no-op", () => {
    // the old test picked A/B by the LAST char but replaced the second-to-last: ~1 in 64 seals came out unchanged
    for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
      for (const last of ["A", "B", "z"]) {
        const sealed = `k.iv.xyz${c}${last}`;
        expect(tamper(sealed)).not.toBe(sealed);
      }
  });

  it("every tampered seal is refused (many random seals)", () => {
    for (let i = 0; i < 300; i++) expect(unseal(tamper(seal({ personId: `p${i}` }, [A], null)), [A], NOW)).toBeNull();
  });

  it("null on tampering, garbage or an unknown key", () => {
    const s = seal({ personId: "p1" }, [A], null);
    expect(unseal(tamper(s), [A], NOW)).toBeNull();
    expect(unseal("nope", [A], NOW)).toBeNull();
    expect(unseal("a.b.c", [A], NOW)).toBeNull();
    expect(unseal("", [A], NOW)).toBeNull();
    expect(unseal(s, [B], NOW)).toBeNull();
  });

  it("refuses to seal without a secret", () => {
    expect(() => seal("x", [], null)).toThrow();
  });
});
