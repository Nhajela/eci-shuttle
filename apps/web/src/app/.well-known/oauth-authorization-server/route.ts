/** web-mcp: RFC 8414 metadata: auth/oauth.authorizationServerMetadata(origin()). */
export const dynamic = "force-dynamic";

const notYet = () => Response.json({ error: "not implemented" }, { status: 501 });

export const GET = notYet;
