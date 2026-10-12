import { formatIst } from "@eci-shuttle/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { CreateWorkspaceForm } from "@/components/admin/workspaces/create-workspace-form";
import { SimPanel } from "@/components/admin/workspaces/sim-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { listVehicles } from "@/services/catalog/vehicles";
import { listMyWorkspaces } from "@/services/catalog/workspaces";
import { listPhones } from "@/services/devices/phones";
import { isSimDevice } from "./sim";

/** admin-workspaces (SPEC §7): create test workspaces, start or stop a simulated device. */
export const metadata: Metadata = { title: "Workspaces" };

export default async function WorkspacesPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const { actor, workspace, role } = await requireAdmin({ w });
  const d = db();
  const mine = await listMyWorkspaces(d, actor);
  const canSim = !workspace.isLive && role === "admin";
  const [vehicles, phones] = canSim
    ? await Promise.all([
        listVehicles(d, actor, { workspaceId: workspace.id }),
        listPhones(d, actor, { workspaceId: workspace.id }, new Date()),
      ])
    : [[], []];
  const sims = phones
    .map((p) => p.device)
    .filter(isSimDevice)
    .map((s) => ({ id: s.id, label: s.label, lastSync: s.lastSyncAt ? formatIst(s.lastSyncAt) : null }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <h1 className="font-semibold text-xl">Workspaces</h1>

      <Card>
        <CardHeader>
          <CardTitle>Yours</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2">
            {mine.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/admin/workspaces?w=${m.slug}`}
                  aria-current={m.id === workspace.id ? "page" : undefined}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-lg border p-3 aria-[current=page]:border-primary"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{m.name}</span>
                    <span className="block text-muted-foreground text-sm">
                      {m.isLive ? "/" : `/w/${m.slug}`} · {m.role}
                    </span>
                  </span>
                  {m.isLive ? <Badge>LIVE</Badge> : <Badge variant="secondary">TEST</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {mine.some((m) => m.role === "admin") && (
        <Card>
          <CardHeader>
            <CardTitle>New test workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateWorkspaceForm w={workspace.slug} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Simulated phones in {workspace.name}</CardTitle>
        </CardHeader>
        <CardContent>
          {workspace.isLive ? (
            <p className="text-muted-foreground text-sm">Simulated phones only run in test workspaces.</p>
          ) : role !== "admin" ? (
            <p className="text-muted-foreground text-sm">Only admins can start or stop simulated phones.</p>
          ) : (
            <SimPanel w={workspace.slug} vehicles={vehicles.filter((v) => v.active).map((v) => v.name)} sims={sims} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
