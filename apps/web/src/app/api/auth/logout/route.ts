/** POST /api/auth/logout: clears the session cookie and goes to /login. */
import { origin } from "@/lib/env";
import { endSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST() {
  await endSession();
  return new Response(null, { status: 303, headers: { Location: `${origin()}/login` } });
}
