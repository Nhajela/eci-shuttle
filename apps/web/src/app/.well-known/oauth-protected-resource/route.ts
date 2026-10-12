/** web-mcp: RFC 9728 metadata: auth/oauth.protectedResourceMetadata(origin()). */
export const dynamic = "force-dynamic";

const notYet = () => Response.json({ error: "not implemented" }, { status: 501 });

export const GET = notYet;
