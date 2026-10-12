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

type SealedClient = { redirectUris: string[]; name: string | null };
type SealedCode = { personId: string; clientId: string; redirectUri: string; codeChallenge: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);
const invalid = (message: string) => new ServiceError("INVALID", message);

function url(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

const isLoopback = (u: URL) => u.protocol === "http:" && LOOPBACK.has(u.hostname);
const allowedRedirect = (u: URL | null) => !!u && !u.hash && (u.protocol === "https:" || isLoopback(u));

/** Exact match, or for loopback any port with the same host, path and query (RFC 8252 §7.3). */
function redirectMatches(registered: string[], uri: string): boolean {
  const b = url(uri);
  return registered.some((r) => {
    if (r === uri) return true;
    const a = url(r);
    return (
      !!a &&
      !!b &&
      isLoopback(a) &&
      isLoopback(b) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  });
}

function openClient(clientId: string, secrets: string[], now: number): SealedClient {
  const c = unseal<SealedClient>(clientId, secrets, now);
  if (!c || !Array.isArray(c.redirectUris)) throw invalid("Unknown client. Remove the connector and add it again.");
  return c;
}

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
  const bad = redirect_uris.find((u) => !allowedRedirect(url(u)));
  if (bad) throw invalid(`Redirect URI not allowed: ${bad.slice(0, 200)}`);
  const name = client_name || null;
  return {
    client_id: seal({ redirectUris: redirect_uris, name } satisfies SealedClient, secrets, null),
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
  const client = openClient(p.client_id, secrets, now);
  if (!redirectMatches(client.redirectUris, p.redirect_uri))
    throw invalid("This redirect address isn't registered for the client.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) throw invalid("code_challenge must be a 43-character S256 value.");
  return {
    clientName: client.name,
    redirectUri: p.redirect_uri,
    state: p.state ?? null,
    codeChallenge: p.code_challenge,
  };
}

/** After the logged-in person pressed Allow: a sealed code (OAUTH_CODE_TTL_MS) bound to person, client, URI, PKCE. */
export function issueAuthCode(
  input: { personId: string; clientId: string; redirectUri: string; codeChallenge: string },
  secrets: string[],
  now: number,
): string {
  return seal(
    {
      personId: input.personId,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
    } satisfies SealedCode,
    secrets,
    now + OAUTH_CODE_TTL_MS,
  );
}

function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
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
  const t = now.getTime();
  const code = unseal<SealedCode>(input.code, secrets, t);
  if (!code) throw invalid("The code is invalid or expired.");
  if (code.clientId !== input.clientId) throw invalid("The code was issued to another client.");
  if (code.redirectUri !== input.redirectUri) throw invalid("redirect_uri does not match.");
  if (!pkceOk(input.codeVerifier, code.codeChallenge)) throw invalid("PKCE verification failed.");
  const client = openClient(code.clientId, secrets, t);
  const { token } = await issueOAuthToken(
    db,
    { personId: code.personId, client: client.name, expiresAt: new Date(t + OAUTH_TOKEN_TTL_MS) },
    now,
  );
  return { access_token: token, token_type: "Bearer", expires_in: OAUTH_TOKEN_TTL_MS / 1000 };
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
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728 document for /.well-known/oauth-protected-resource (resource = <origin>/api/mcp). */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_name: "ECI Shuttle",
  };
}
