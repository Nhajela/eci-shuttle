/**
 * GET /api/positions?w=<slug>: live vehicle positions, stops and routes for the public map (SPEC §6). No login.
 * Only vehicles on an active shift of a public service with a fresh fix (services/public/positions). No ?w → the
 * live workspace. Edge-cached 5s like /api/status.
 */
import { db } from "@/db";
import { workspaceBySlug } from "@/services/catalog/workspaces";
import { publicPositions } from "@/services/public/positions";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const slug = new URL(req.url).searchParams.get("w");
  const ws = await workspaceBySlug(db(), slug);
  if (!ws) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  const map = await publicPositions(db(), ws.id, new Date());
  return Response.json(map, { headers: { "Cache-Control": "public, s-maxage=5" } });
}
