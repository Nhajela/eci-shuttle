/** web-auth (SPEC §6c): "Log in with Telegram", polling until the bot confirms. */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginButton } from "@/components/auth/LoginButton";
import { currentPerson, safeNext } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Log in", robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await currentPerson()) redirect(next);
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] font-bold leading-tight">ECI Shuttle admin</h1>
        <p className="text-[16px] leading-6 text-muted-foreground">
          Log in with the Telegram account an admin added to the shuttle team.
        </p>
      </div>
      <LoginButton next={next} />
    </main>
  );
}
