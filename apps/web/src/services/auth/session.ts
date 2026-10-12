/**
 * svc-auth: the admin session cookie (SPEC §6c: signed, 60 days). Pure: the secret and now are parameters;
 * lib/session reads/writes the cookie and env. Stateless: losing access = losing the membership (the Actor is
 * rebuilt from memberships on every request), so there is no server-side session table.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "shuttle_session";
export const SESSION_TTL_MS = 60 * 24 * 60 * 60_000;

export type Session = { personId: string; issuedAt: number };

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest();

/** "<base64url(json)>.<base64url(HMAC-SHA256(json, secret))>" */
export function signSession(session: Session, secret: string): string {
  const json = JSON.stringify({ personId: session.personId, issuedAt: session.issuedAt });
  return `${Buffer.from(json).toString("base64url")}.${mac(json, secret).toString("base64url")}`;
}

/** null when missing, malformed, tampered (constant-time compare) or older than SESSION_TTL_MS at now. */
export function verifySession(value: string | undefined | null, secret: string, now: number): Session | null {
  const [body, sig, extra] = (value ?? "").split(".");
  if (!body || !sig || extra !== undefined) return null;
  const json = Buffer.from(body, "base64url").toString();
  const want = mac(json, secret);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const s = JSON.parse(json) as Session;
    if (typeof s.personId !== "string" || typeof s.issuedAt !== "number") return null;
    return now - s.issuedAt > SESSION_TTL_MS ? null : { personId: s.personId, issuedAt: s.issuedAt };
  } catch {
    return null;
  }
}
