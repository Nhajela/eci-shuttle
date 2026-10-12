/**
 * svc-auth: the admin session cookie (SPEC §6c: signed, 60 days). Pure: the secret and now are parameters;
 * lib/session reads/writes the cookie and env. Stateless: losing access = losing the membership (the Actor is
 * rebuilt from memberships on every request), so there is no server-side session table.
 */
import { notImplemented } from "@eci-shuttle/shared";

export const SESSION_COOKIE = "shuttle_session";
export const SESSION_TTL_MS = 60 * 24 * 60 * 60_000;

export type Session = { personId: string; issuedAt: number };

/** "<base64url(json)>.<base64url(HMAC-SHA256(json, secret))>" */
export function signSession(session: Session, secret: string): string {
  return notImplemented(session, secret);
}

/** null when missing, malformed, tampered (constant-time compare) or older than SESSION_TTL_MS at now. */
export function verifySession(value: string | undefined | null, secret: string, now: number): Session | null {
  return notImplemented(value, secret, now);
}
