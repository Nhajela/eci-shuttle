/** web-auth (SPEC §6c): the magic link's "Continue as …" page. GET never logs in (link previews); its button POSTs. */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import type { Person } from "@/db/types";
import { currentPerson, safeNext } from "@/lib/session";
import { peekLogin } from "@/services/auth/codes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Log in", robots: { index: false } };

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "";
const name = (p: Person) => p.firstName || (p.username ? `@${p.username}` : "you");

export default async function MagicLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; next?: string }>;
}) {
  const { code = "", next: rawNext } = await searchParams;
  const next = safeNext(rawNext);
  const [state, current] = await Promise.all([code ? peekLogin(db(), code, new Date()) : null, currentPerson()]);
  const target = state?.status === "ready" ? state.person : null;
  if (target && current?.id === target.id) redirect(next);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
      {target ? (
        <>
          <div className="flex flex-col gap-2">
            <h1 className="text-[28px] font-bold leading-tight">Continue as {name(target)}?</h1>
            <p className="text-[16px] leading-6 text-muted-foreground">
              {current
                ? `You're logged in as ${name(current)} in this browser. Continuing switches to ${name(target)}.`
                : "This link came from the shuttle bot on Telegram. Only continue if you asked for it."}
            </p>
          </div>
          <form method="post" action="/api/auth/magic" className="flex flex-col gap-2">
            <input type="hidden" name="code" value={code} />
            <input type="hidden" name="next" value={next} />
            <Button type="submit" size="lg" className="w-full">
              Continue as {name(target)}
            </Button>
            <Button size="lg" variant="ghost" className="w-full" render={<a href="/" />}>
              Not me
            </Button>
          </form>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <h1 className="text-[28px] font-bold leading-tight">That login link has expired.</h1>
            <p className="text-[16px] leading-6 text-muted-foreground">
              Links from the bot work once, for 15 minutes.{" "}
              {BOT ? (
                <>
                  Message{" "}
                  <a className="underline underline-offset-2" href={`https://t.me/${BOT}`}>
                    @{BOT}
                  </a>{" "}
                  for a fresh one, or log in below.
                </>
              ) : (
                "Log in below instead."
              )}
            </p>
          </div>
          <Button size="lg" className="w-full" render={<a href={`/login?next=${encodeURIComponent(next)}`} />}>
            Log in with Telegram
          </Button>
        </>
      )}
    </main>
  );
}
