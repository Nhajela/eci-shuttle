/**
 * svc-auth: OAuth 2.1 for the MCP connector (SPEC §7a: "Connect" → Telegram login → a token bound to that
 * admin). Public clients with PKCE S256 and dynamic registration (what claude.ai / ChatGPT connectors use).
 * Stateless: client ids and codes are sealed (auth/seal) with TOKEN_SECRETS; only the issued access token is
 * stored (mcp_tokens, kind oauth). Endpoints (web-mcp adapter):
 *   /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource,
 *   /api/mcp/oauth/register, /api/mcp/oauth/authorize (Telegram login, then Allow), /api/mcp/oauth/token.
 * ponytail: codes are not single-use (no table); PKCE + 5 min expiry bound the replay window.
 */
import { notImplemented } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";

export const OAUTH_CODE_TTL_MS = 5 * 60_000;
/** Access tokens from OAuth expire; claude.ai reconnects. Personal shs_ tokens don't. */
export const OAUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/** RFC 7591 request body. Redirect URIs must be https, or http on localhost / 127.0.0.1. */
export const ClientRegistration = z.object({
  redirect_uris: z.array(z.url()).min(1).max(10),
  client_name: z.string().trim().max(100).optional(),
});
export type RegisteredClient = {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: ["authorization_code"];
  response_types: ["code"];
};

/** client_id = seal({redirectUris, name}) with no expiry. Bad redirect URI → INVALID. */
export function registerClient(input: z.input<typeof ClientRegistration>, secrets: string[]): RegisteredClient {
  return notImplemented(input, secrets);
}

export const AuthorizeParams = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.url(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(500).optional(),
  scope: z.string().max(500).optional(),
});

/**
 * Validate /authorize before showing anything: the client id must open and redirect_uri must be one of its
 * registered URIs, else INVALID (and the adapter shows an error page, never redirecting to an unchecked URI).
 */
export function validateAuthorize(
  params: z.input<typeof AuthorizeParams>,
  secrets: string[],
  now: number,
): { clientName: string | null; redirectUri: string; state: string | null; codeChallenge: string } {
  return notImplemented(params, secrets, now);
}

/** After the logged-in person pressed Allow: a sealed code (OAUTH_CODE_TTL_MS) bound to person, client, URI, PKCE. */
export function issueAuthCode(
  input: { personId: string; clientId: string; redirectUri: string; codeChallenge: string },
  secrets: string[],
  now: number,
): string {
  return notImplemented(input, secrets, now);
}

/**
 * POST /token, grant_type=authorization_code: the code opens, client_id and redirect_uri match, and
 * base64url(sha256(code_verifier)) == the challenge, else INVALID (adapter answers `invalid_grant`). Issues an
 * oauth token via mcp/tokens.issueOAuthToken (client = the registered client_name).
 */
export async function exchangeAuthCode(
  db: Db,
  input: { code: string; codeVerifier: string; clientId: string; redirectUri: string },
  now: Date,
): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number }> {
  return notImplemented(db, input, now);
}

/** RFC 8414 document for /.well-known/oauth-authorization-server (issuer = origin). */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return notImplemented(origin);
}

/** RFC 9728 document for /.well-known/oauth-protected-resource (resource = <origin>/api/mcp). */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return notImplemented(origin);
}
