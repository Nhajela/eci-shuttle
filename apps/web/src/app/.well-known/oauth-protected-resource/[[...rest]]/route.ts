/** web-mcp: RFC 9728 metadata, also at path-suffixed variants (/.well-known/oauth-protected-resource/api/mcp). */
import { CORS, preflight } from "@/app/api/mcp/oauth/cors";
import { origin } from "@/lib/env";
import { protectedResourceMetadata } from "@/services/auth/oauth";

export const GET = () => Response.json(protectedResourceMetadata(origin()), { headers: CORS });
export const OPTIONS = preflight("GET");
