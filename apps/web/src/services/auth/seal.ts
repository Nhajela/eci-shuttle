/**
 * svc-auth: sealed (encrypted + authenticated) short-lived values, so OAuth client registrations and
 * authorization codes need no table (stateless, as eci-events-mcp). Keys come from TOKEN_SECRETS: the first
 * seals, every one opens (rotation). Pure: secrets and now are parameters.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const key = (secret: string) => createHash("sha256").update(secret).digest();
/** which secret sealed it, without revealing anything about the secret */
const hint = (secret: string) => createHash("sha256").update(`hint:${secret}`).digest("base64url").slice(0, 6);

/**
 * AES-256-GCM over JSON {p: payload, exp: expiresAt}, key = sha256(secret), output base64url
 * "<keyIndexHint>.<iv>.<ciphertext+tag>" (URL-safe, no padding). expiresAt null = never expires.
 */
export function seal(payload: unknown, secrets: string[], expiresAt: number | null): string {
  const secret = secrets[0];
  if (!secret) throw new Error("seal: no secret");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ p: payload, exp: expiresAt })), c.final(), c.getAuthTag()]);
  return `${hint(secret)}.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

/** The payload, or null when malformed, sealed with an unknown key, tampered or expired at now. */
export function unseal<T>(sealed: string, secrets: string[], now: number): T | null {
  const [h, ivB, ctB, extra] = sealed.split(".");
  const secret = secrets.find((s) => hint(s) === h);
  if (!secret || !ivB || !ctB || extra !== undefined) return null;
  try {
    const ct = Buffer.from(ctB, "base64url");
    const d = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(ivB, "base64url"));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const { p, exp } = JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString());
    return exp != null && now >= exp ? null : (p as T);
  } catch {
    return null;
  }
}
