/** web-mcp: OAuth token endpoint (authorization_code + PKCE only; tokens last 30 days, then the connector reconnects). */
import { db } from "@/db";
import { exchangeAuthCode } from "@/services/auth/oauth";
import { isServiceError } from "@/services/kernel";
import { CORS, preflight } from "../cors";

const headers = { ...CORS, "Cache-Control": "no-store" };
const err = (error: string, error_description: string) =>
  Response.json({ error, error_description }, { status: 400, headers });

async function params(request: Request): Promise<URLSearchParams> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json"))
    return new URLSearchParams(await request.text());
  const j: unknown = await request.json().catch(() => null);
  if (!j || typeof j !== "object" || Array.isArray(j)) return new URLSearchParams();
  return new URLSearchParams(Object.entries(j).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export async function POST(request: Request): Promise<Response> {
  const p = await params(request);
  if (p.get("grant_type") !== "authorization_code")
    return err("unsupported_grant_type", "Only authorization_code is supported.");
  const code = p.get("code");
  const codeVerifier = p.get("code_verifier");
  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  if (!code || !codeVerifier || !clientId || !redirectUri)
    return err("invalid_request", "code, code_verifier, client_id and redirect_uri are required.");
  try {
    const token = await exchangeAuthCode(db(), { code, codeVerifier, clientId, redirectUri }, new Date());
    return Response.json(token, { headers });
  } catch (e) {
    if (isServiceError(e) && e.code === "INVALID") return err("invalid_grant", e.message);
    throw e;
  }
}

export const OPTIONS = preflight("POST");
