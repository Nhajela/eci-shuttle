/** web-public: GET /api/status?w=<slug> → PublicStatus (svc-public), Cache-Control: s-maxage=5 (SPEC §6). */
export const dynamic = "force-dynamic";

const notYet = () => Response.json({ error: "not implemented" }, { status: 501 });

export const GET = notYet;
