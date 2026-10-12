import type { Metadata } from "next";
import { PairPanel } from "@/components/admin/phones/pair-panel";
import { PhoneCard } from "@/components/admin/phones/phone-card";
import { RolloutPanel } from "@/components/admin/phones/rollout-panel";
import { phoneProblems, toPhoneView } from "@/components/admin/phones/view";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { listVehicles } from "@/services/catalog/vehicles";
import { listMyWorkspaces } from "@/services/catalog/workspaces";
import { listPhones } from "@/services/devices/phones";

/** admin-phones (SPEC §7): Pair (QR + code), label, assign, health, kill / revoke / nudge, silence, force active, move workspace, OTA. */
export const metadata: Metadata = { title: "Phones" };
export const dynamic = "force-dynamic";

export default async function PhonesPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const { actor, workspace, role } = await requireAdmin({ w });
  const now = new Date();
  const isAdmin = role === "admin";
  const [all, vehicles, mine] = await Promise.all([
    listPhones(db(), actor, { workspaceId: workspace.id }, now),
    listVehicles(db(), actor, { workspaceId: workspace.id }),
    isAdmin ? listMyWorkspaces(db(), actor) : Promise.resolve([]),
  ]);
  const phones = all.map(toPhoneView); // strips tokenHash/pushToken before anything reaches the client
  // move needs admin in both workspaces (the service checks it again)
  const moveTargets = mine
    .filter((x) => x.id !== workspace.id && x.role === "admin")
    .map((x) => ({ id: x.id, name: x.name }));
  const vehicleOptions = vehicles.filter((v) => v.active).map((v) => ({ id: v.id, name: v.name }));
  const live = phones.filter((h) => !h.device.revokedAt);
  const withProblems = phones.filter((h) => phoneProblems(h, now.getTime()).length > 0).length;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 pb-24">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold">Phones</h1>
        <p className="text-muted-foreground text-sm">
          {live.length} {live.length === 1 ? "phone" : "phones"}
          {withProblems > 0 && ` · ${withProblems} need a look`}
        </p>
      </header>

      {isAdmin && (
        <div className="grid gap-4 md:grid-cols-2">
          <PairPanel w={workspace.slug} workspaceName={workspace.name} />
          <RolloutPanel
            w={workspace.slug}
            workspaceName={workspace.name}
            isLive={workspace.isLive}
            target={workspace.targetUpdateId}
            phoneCount={live.length}
          />
        </div>
      )}

      {phones.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
          No phones yet.
          {isAdmin ? " Make a pairing code above and scan it with the driver app." : " Ask an admin to pair one."}
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {phones.map((h) => (
            <li key={h.device.id}>
              <PhoneCard
                h={h}
                now={now.getTime()}
                w={workspace.slug}
                role={role}
                vehicles={vehicleOptions}
                moveTargets={moveTargets}
                workspaceTarget={workspace.targetUpdateId}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
