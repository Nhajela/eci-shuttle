/**
 * svc-auth: sealed (encrypted + authenticated) short-lived values, so OAuth client registrations and
 * authorization codes need no table (stateless, as eci-events-mcp). Keys come from TOKEN_SECRETS: the first
 * seals, every one opens (rotation). Pure: secrets and now are parameters.
 */
import { notImplemented } from "@eci-shuttle/shared";

/**
 * AES-256-GCM over JSON {p: payload, exp: expiresAt}, key = sha256(secret), output base64url
 * "<keyIndexHint>.<iv>.<ciphertext+tag>" (URL-safe, no padding). expiresAt null = never expires.
 */
export function seal(payload: unknown, secrets: string[], expiresAt: number | null): string {
  return notImplemented(payload, secrets, expiresAt);
}

/** The payload, or null when malformed, sealed with an unknown key, tampered or expired at now. */
export function unseal<T>(sealed: string, secrets: string[], now: number): T | null {
  return notImplemented(sealed, secrets, now);
}
