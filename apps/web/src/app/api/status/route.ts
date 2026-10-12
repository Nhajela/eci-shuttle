/** GET /api/status?w=<slug>: the public answer (SPEC §6). No ?w → the live workspace. Edge-cached 5s (§2b). */
import { db } from "@/db";
import { workspaceBySlug } from "@/services/catalog/workspaces";
import { publicStatus } from "@/services/public/status";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const slug = new URL(req.url).searchParams.get("w");
  const ws = await workspaceBySlug(db(), slug);
  if (!ws) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  const status = await publicStatus(db(), ws.id, new Date());
  return Response.json(status, { headers: { "Cache-Control": "public, s-maxage=5" } });
}
