/**
 * svc-auth: sealed (encrypted + authenticated) short-lived values, so OAuth client registrations and
 * authorization codes need no table (stateless, as eci-events-mcp). Keys come from TOKEN_SECRETS: the first
 * seals, every one opens (rotation). Pure: secrets and now are parameters.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const key = (secret: string) => createHash("sha256").update(secret).digest();
/** Which secret sealed it, so unseal tries one key instead of all (not secret: a hash prefix). */
const hint = (secret: string) => createHash("sha256").update(`hint:${secret}`).digest("base64url").slice(0, 6);

/**
 * AES-256-GCM over JSON {p: payload, exp: expiresAt}, key = sha256(secret), output base64url
 * "<keyIndexHint>.<iv>.<ciphertext+tag>" (URL-safe, no padding). expiresAt null = never expires.
 */
export function seal(payload: unknown, secrets: string[], expiresAt: number | null): string {
  const secret = secrets[0];
  if (!secret) throw new Error("seal: no secret configured (TOKEN_SECRETS)");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([
    c.update(JSON.stringify({ p: payload, exp: expiresAt }), "utf8"),
    c.final(),
    c.getAuthTag(),
  ]);
  return `${hint(secret)}.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

/** The payload, or null when malformed, sealed with an unknown key, tampered or expired at now. */
export function unseal<T>(sealed: string, secrets: string[], now: number): T | null {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 3) return null;
  const [h, ivB64, ctB64] = parts;
  const secret = secrets.find((s) => hint(s) === h);
  if (!secret) return null;
  try {
    const iv = Buffer.from(ivB64, "base64url");
    const ct = Buffer.from(ctB64, "base64url");
    if (iv.length !== 12 || ct.length < 17) return null;
    const d = createDecipheriv("aes-256-gcm", key(secret), iv);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const json = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
    const { p, exp } = JSON.parse(json) as { p: T; exp: number | null };
    if (exp !== null && now >= exp) return null;
    return p;
  } catch {
    return null;
  }
}
