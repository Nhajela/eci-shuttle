/** GET /api/auth/poll → { status: "pending" | "ok" | "expired" }; "ok" has set the session cookie. */
import { db } from "@/db";
import { clearPendingLogin, pendingLogin, startSession } from "@/lib/session";
import { finishLogin } from "@/services/auth/codes";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const code = await pendingLogin();
  if (!code) return Response.json({ status: "expired" }, { headers: NO_STORE });
  const r = await finishLogin(db(), code, "poll", new Date());
  if (r.status === "ok") await startSession(r.person.id);
  if (r.status !== "pending") await clearPendingLogin();
  return Response.json({ status: r.status }, { headers: NO_STORE });
}
