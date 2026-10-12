/** web-device: POST /api/device/sync (SPEC §4): devices/sync.authenticateDevice + syncDevice. */
import { SyncRequest } from "@eci-shuttle/shared";
import { db } from "@/db";
import { authenticateDevice, syncDevice } from "@/services/devices/sync";
import { errorResponse, rateLimiter, readBody, tooMany } from "../rateLimit";

export const dynamic = "force-dynamic";

// A phone syncs every ~15 s when active; pushes, Resume and backlog flushes add a few more.
const limit = rateLimiter(12, 60_000);

export async function POST(req: Request) {
  try {
    const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
    const actor = await authenticateDevice(db(), bearer);
    const now = new Date();
    const wait = limit(actor.id, now.getTime());
    if (wait !== null) return tooMany(wait);
    const input = await readBody(req, SyncRequest);
    return Response.json(await syncDevice(db(), actor, input, now), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
