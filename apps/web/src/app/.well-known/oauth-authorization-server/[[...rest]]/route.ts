/** web-mcp: RFC 8414 metadata, also at path-suffixed variants (/.well-known/oauth-authorization-server/api/mcp). */
import { CORS, preflight } from "@/app/api/mcp/oauth/cors";
import { origin } from "@/lib/env";
import { authorizationServerMetadata } from "@/services/auth/oauth";

export const GET = () => Response.json(authorizationServerMetadata(origin()), { headers: CORS });
export const OPTIONS = preflight("GET");
