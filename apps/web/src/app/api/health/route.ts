/**
 * GET /api/health: 200 only when the database answers and a worker beat < 3 min ago (SPEC §2b). Uptime monitoring.
 * GET /api/health?live=1: liveness, 200 when this web process and the database answer, whatever the worker is
 * doing. The container health check uses it, so a fresh DB or a down worker never rolls back a web deploy.
 */
import { db } from "@/db";
import { checkHealth, type Health } from "@/services/health/health";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let h: Health;
  try {
    h = await checkHealth(db(), new Date());
  } catch {
    // db() throws when DATABASE_URL is missing
    h = { ok: false, db: false, heartbeatAt: null, heartbeatAgeS: null };
  }
  if (new URL(req.url).searchParams.has("live")) h = { ...h, ok: h.db };
  return Response.json(h, { status: h.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
