/** GET /api/staff-map?w=<slug>: the live map for a logged-in member of that workspace (viewer+). Never cached. */
import { db } from "@/db";
import { currentPerson } from "@/lib/session";
import { adminActor } from "@/services/auth/actor";
import { workspaceBySlug } from "@/services/catalog/workspaces";
import { httpStatus, isServiceError, userMessage } from "@/services/kernel";
import { staffMap } from "@/services/public/staff-map";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: Request): Promise<Response> {
  const person = await currentPerson();
  if (!person) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401, headers: NO_STORE });
  const ws = await workspaceBySlug(db(), new URL(req.url).searchParams.get("w"));
  if (!ws) return Response.json({ error: "NOT_FOUND" }, { status: 404, headers: NO_STORE });
  try {
    const actor = await adminActor(db(), { personId: person.id, workspaceId: ws.id, channel: "web" });
    return Response.json(await staffMap(db(), actor, { workspaceId: ws.id }, new Date()), { headers: NO_STORE });
  } catch (e) {
    if (!isServiceError(e)) throw e;
    return Response.json({ error: userMessage(e) }, { status: httpStatus(e), headers: NO_STORE });
  }
}
