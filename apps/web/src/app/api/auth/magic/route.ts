/** POST /api/auth/magic (form: code, next): the "Continue as …" button. Uses the code once, then goes to next. */
import { db } from "@/db";
import { origin } from "@/lib/env";
import { safeNext, startSession } from "@/lib/session";
import { finishLogin } from "@/services/auth/codes";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const form = await req.formData();
  const code = String(form.get("code") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  const r = code ? await finishLogin(db(), code, new Date()) : { status: "expired" as const };
  if (r.status === "ok") {
    await startSession(r.person.id);
    return new Response(null, { status: 303, headers: { Location: `${origin()}${next}` } });
  }
  // back to the page, which now explains the link has expired
  return new Response(null, {
    status: 303,
    headers: { Location: `${origin()}/login/magic?code=${encodeURIComponent(code)}` },
  });
}
