/** GET /api/health: 200 only when the database answers and a worker beat < 3 min ago (SPEC §2b). */
import { db } from "@/db";
import { checkHealth, type Health } from "@/services/health/health";

export const dynamic = "force-dynamic";

export async function GET() {
  let h: Health;
  try {
    h = await checkHealth(db(), new Date());
  } catch {
    // db() throws when DATABASE_URL is missing
    h = { ok: false, db: false, heartbeatAt: null, heartbeatAgeS: null };
  }
  return Response.json(h, { status: h.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
