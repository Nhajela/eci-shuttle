/** web-mcp: /api/mcp, streamable HTTP, stateless (SPEC §7a). Bearer via mcp/tokens.authenticateMcp; tools in src/mcp/. */
export const dynamic = "force-dynamic";

const notYet = () => Response.json({ error: "not implemented" }, { status: 501 });

export const GET = notYet;
export const POST = notYet;
