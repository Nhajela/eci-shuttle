/** web-mcp: RFC 7591 dynamic client registration over auth/oauth.registerClient (stateless: the id is sealed). */
import { env } from "@/lib/env";
import { registerClient } from "@/services/auth/oauth";
import { isServiceError } from "@/services/kernel";
import { CORS, preflight } from "../cors";

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  try {
    const client = registerClient(body ?? {}, env.tokenSecrets());
    return Response.json(client, { status: 201, headers: CORS });
  } catch (e) {
    if (!isServiceError(e)) throw e;
    const error = /redirect/i.test(e.message) ? "invalid_redirect_uri" : "invalid_client_metadata";
    return Response.json({ error, error_description: e.message }, { status: 400, headers: CORS });
  }
}

export const OPTIONS = preflight("POST");
