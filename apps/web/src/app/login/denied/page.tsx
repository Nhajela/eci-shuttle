/** web-auth: where lib/session.requireAdmin sends people with no membership, or below the role a page needs. */
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { currentPerson } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "No access", robots: { index: false } };

export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ why?: string; need?: string; w?: string }>;
}) {
  const { why, need, w } = await searchParams;
  const person = await currentPerson();
  const who = person?.firstName || (person?.username ? `@${person.username}` : "This account");
  const role = why === "role" && need ? need : null;
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] font-bold leading-tight">
          {role ? "You don't have access to this page." : "Ask an admin to add you."}
        </h1>
        <p className="text-[16px] leading-6 text-muted-foreground">
          {role
            ? `It needs the ${role} role. Ask an admin of this workspace if you need it.`
            : `${who} isn't on the shuttle team yet. An admin can add you under People.`}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {role && (
          <Button size="lg" className="w-full" render={<a href={w ? `/admin?w=${encodeURIComponent(w)}` : "/admin"} />}>
            Back to admin
          </Button>
        )}
        <form method="post" action="/api/auth/logout">
          <Button type="submit" size="lg" variant="ghost" className="w-full">
            Log out
          </Button>
        </form>
      </div>
    </main>
  );
}
