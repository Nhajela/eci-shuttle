import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS, signSession, verifySession } from "./session";

const SECRET = "s".repeat(32);
const now = 1_790_000_000_000;

describe("session cookie", () => {
  it("round-trips", () => {
    const v = signSession({ personId: "p1", issuedAt: now }, SECRET);
    expect(verifySession(v, SECRET, now + 1000)).toEqual({ personId: "p1", issuedAt: now });
  });

  it("rejects missing, malformed, tampered, wrong secret and expired", () => {
    const v = signSession({ personId: "p1", issuedAt: now }, SECRET);
    const [body, sig] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ personId: "p2", issuedAt: now })).toString("base64url");
    expect(verifySession(undefined, SECRET, now)).toBeNull();
    expect(verifySession("garbage", SECRET, now)).toBeNull();
    expect(verifySession(`${forged}.${sig}`, SECRET, now)).toBeNull();
    expect(verifySession(`${body}.${sig}x`, SECRET, now)).toBeNull();
    expect(verifySession(v, "t".repeat(32), now)).toBeNull();
    expect(verifySession(v, SECRET, now + SESSION_TTL_MS + 1)).toBeNull();
  });
});
