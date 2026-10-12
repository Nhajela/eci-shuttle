/** POST /api/auth/start → { url }: a fresh Telegram deep link; this browser remembers the code to poll. */
import { db } from "@/db";
import { setPendingLogin } from "@/lib/session";
import { startLogin } from "@/services/auth/codes";
import { httpStatus, userMessage } from "@/services/kernel";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST() {
  try {
    const { code, deepLink } = await startLogin(db(), new Date());
    await setPendingLogin(code);
    return Response.json({ url: deepLink }, { headers: NO_STORE });
  } catch (e) {
    console.error("auth/start", e);
    return Response.json({ error: userMessage(e) }, { status: httpStatus(e), headers: NO_STORE });
  }
}
