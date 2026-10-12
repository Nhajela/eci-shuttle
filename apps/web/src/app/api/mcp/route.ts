/**
 * web-mcp: /api/mcp, streamable HTTP, stateless (SPEC §7a), ported from eci-events-mcp. A fresh McpServer per
 * request, built for the person behind the bearer token (mcp/tokens.authenticateMcp).
 * 2026-07-28 clients go through createMcpHandler; 2025-era clients (initialize handshake) are routed with
 * isLegacyRequest to a per-request transport with JSON responses (the SDK's own legacy fallback always streams SSE).
 */
import {
  type AuthInfo,
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { db } from "@/db";
import { origin } from "@/lib/env";
import { buildContext, type McpContext } from "@/mcp/context";
import { buildServer } from "@/mcp/server";
import { SERVER_NAME, UNAUTHORIZED_DESCRIPTION } from "@/mcp/text";
import { isServiceError } from "@/services/kernel";
import { authenticateMcp } from "@/services/mcp/tokens";

export const dynamic = "force-dynamic";

const handler = createMcpHandler(
  ({ authInfo }) => {
    const ctx = authInfo?.extra?.ctx as McpContext | undefined;
    if (!ctx) throw new Error("MCP handler invoked without authInfo.extra.ctx");
    return buildServer(ctx);
  },
  { legacy: "reject", responseMode: "json" },
);

async function serveLegacy(request: Request, authInfo: AuthInfo, ctx: McpContext): Promise<Response> {
  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { authInfo });
  } finally {
    await server.close().catch(() => {});
  }
}

function unauthorized(tokenPresented: boolean): Response {
  const error = tokenPresented ? 'error="invalid_token", ' : "";
  return Response.json(
    { error: "unauthorized", error_description: UNAUTHORIZED_DESCRIPTION },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer ${error}resource_metadata="${origin()}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  const header = request.headers.get("authorization");
  const now = new Date();
  let auth: Awaited<ReturnType<typeof authenticateMcp>>;
  try {
    auth = await authenticateMcp(db(), header, now);
  } catch (e) {
    if (isServiceError(e) && e.code === "UNAUTHENTICATED") return unauthorized(Boolean(header?.trim()));
    throw e;
  }
  const ctx = await buildContext(db(), auth.person, auth.token, now);
  const authInfo: AuthInfo = { token: "[redacted]", clientId: SERVER_NAME, scopes: [], extra: { ctx } };
  return (await isLegacyRequest(request)) ? serveLegacy(request, authInfo, ctx) : handler.fetch(request, { authInfo });
}

export function GET(): Response {
  return Response.json({ error: "Use POST." }, { status: 405, headers: { Allow: "POST" } });
}

export const DELETE = GET;
