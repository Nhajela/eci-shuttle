/**
 * svc-auth: OAuth 2.1 for the MCP connector (SPEC §7a: "Connect" → Telegram login → a token bound to that
 * admin). Public clients with PKCE S256 and dynamic registration (what claude.ai / ChatGPT connectors use).
 * Stateless: client ids and codes are sealed (auth/seal) with TOKEN_SECRETS; only the issued access token is
 * stored (mcp_tokens, kind oauth). Endpoints (web-mcp adapter):
 *   /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource,
 *   /api/mcp/oauth/register, /api/mcp/oauth/authorize (Telegram login, then Allow), /api/mcp/oauth/token.
 * ponytail: codes are not single-use (no table); PKCE + 5 min expiry bound the replay window.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/db";
import { env } from "@/lib/env";
import { parseInput, ServiceError } from "../kernel";
import { issueOAuthToken } from "../mcp/tokens";
import { seal, unseal } from "./seal";

export const OAUTH_CODE_TTL_MS = 5 * 60_000;
/** Access tokens from OAuth expire; claude.ai reconnects. Personal shs_ tokens don't. */
export const OAUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/** `k` keeps a sealed client id from passing as a sealed code and back. */
type ClientSeal = { k: "client"; r: string[]; n: string | null };
type CodeSeal = { k: "code"; personId: string; clientId: string; redirectUri: string; codeChallenge: string };

const invalid = (msg: string) => new ServiceError("INVALID", msg);

const allowedRedirect = (u: string) => {
  const url = new URL(u);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
};

const openClient = (clientId: string, secrets: string[]): ClientSeal => {
  const c = unseal<ClientSeal>(clientId, secrets, 0);
  if (c?.k !== "client") throw invalid("Unknown client.");
  return c;
};

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
  const { redirect_uris, client_name } = parseInput(ClientRegistration, input);
  if (!redirect_uris.every(allowedRedirect))
    throw invalid("Redirect URIs must be https (or http on localhost / 127.0.0.1).");
  const name = client_name || null;
  return {
    client_id: seal({ k: "client", r: redirect_uris, n: name } satisfies ClientSeal, secrets, null),
    client_name: name,
    redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
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
  const p = parseInput(AuthorizeParams, params);
  const c = openClient(p.client_id, secrets);
  if (!c.r.includes(p.redirect_uri)) throw invalid("That redirect URI isn't registered for this client.");
  void now; // client ids never expire; kept for the contract
  return { clientName: c.n, redirectUri: p.redirect_uri, state: p.state ?? null, codeChallenge: p.code_challenge };
}

/** After the logged-in person pressed Allow: a sealed code (OAUTH_CODE_TTL_MS) bound to person, client, URI, PKCE. */
export function issueAuthCode(
  input: { personId: string; clientId: string; redirectUri: string; codeChallenge: string },
  secrets: string[],
  now: number,
): string {
  return seal({ k: "code", ...input } satisfies CodeSeal, secrets, now + OAUTH_CODE_TTL_MS);
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
  const secrets = env.tokenSecrets();
  const c = unseal<CodeSeal>(input.code, secrets, now.getTime());
  if (c?.k !== "code" || c.clientId !== input.clientId || c.redirectUri !== input.redirectUri)
    throw invalid("Invalid or expired authorization code.");
  const got = Buffer.from(createHash("sha256").update(input.codeVerifier).digest("base64url"));
  const want = Buffer.from(c.codeChallenge);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw invalid("PKCE verification failed.");
  const { n } = openClient(c.clientId, secrets);
  const issued = await issueOAuthToken(
    db,
    { personId: c.personId, client: n, expiresAt: new Date(now.getTime() + OAUTH_TOKEN_TTL_MS) },
    now,
  );
  return { access_token: issued.token, token_type: "Bearer", expires_in: OAUTH_TOKEN_TTL_MS / 1000 };
}

/** RFC 8414 document for /.well-known/oauth-authorization-server (issuer = origin). */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

/** RFC 9728 document for /.well-known/oauth-protected-resource (resource = <origin>/api/mcp). */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return { resource: `${origin}/api/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"] };
}
