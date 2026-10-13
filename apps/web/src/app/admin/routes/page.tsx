import type { Metadata } from "next";
import { PathEditor } from "@/components/admin/routes/PathEditor";
import { RouteForm } from "@/components/admin/routes/RouteForm";
import { legRows, spotChain } from "@/components/admin/routes/routes";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { listRoutes } from "@/services/catalog/routes";
import { listSpots } from "@/services/catalog/spots";
import { can } from "@/services/kernel";

/** admin-routes (SPEC §7): spots in order, generated path and adjust, learned leg times. */
export const metadata: Metadata = { title: "Routes" };

export default async function RoutesPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const { actor, workspace } = await requireAdmin({ w });
  const input = { workspaceId: workspace.id };
  const [routes, allSpots] = await Promise.all([
    listRoutes(db(), actor, input),
    listSpots(db(), actor, { ...input, includeArchived: true }),
  ]);
  const canEdit = can(actor, workspace.id, "ops");
  const names = Object.fromEntries(allSpots.map((s) => [s.id, s.name]));
  const spotsById = new Map(allSpots.map((s) => [s.id, s]));
  const pickable = allSpots.filter((s) => !s.archivedAt).map((s) => ({ id: s.id, name: s.name }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-semibold">Routes</h1>
        <p className="text-sm text-muted-foreground">
          The spots a shuttle drives through, in order, and the road between them.
        </p>
      </header>

      {routes.length === 0 && <p className="text-muted-foreground">No routes yet.</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {routes.map((r) => {
          const legs = legRows(r, names);
          const routeSpots = [...new Set(r.spotIds)].flatMap((id) => spotsById.get(id) ?? []);
          return (
            <Card key={r.id}>
              <CardHeader>
                <CardTitle className="text-lg">{r.name}</CardTitle>
                <CardDescription>{spotChain(r.spotIds, names)}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <section>
                  <h2 className="mb-1 text-sm font-medium">Typical leg times</h2>
                  <ul className="flex flex-col divide-y">
                    {legs.map((l, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: legs are positional
                      <li key={i} className="flex justify-between gap-3 py-2">
                        <span className="min-w-0 truncate">
                          {l.from} → {l.to}
                        </span>
                        <span className={l.learned ? "tabular-nums" : "text-muted-foreground"}>{l.time}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">Learned each night from real trips.</p>
                  <p className="mt-2 text-sm">
                    Wait at each stop:{" "}
                    {r.plannedDwellS["*"] != null
                      ? `${r.plannedDwellS["*"] / 60} min`
                      : "not set (3 min until learned)"}
                  </p>
                </section>

                <PathEditor
                  w={workspace.slug}
                  route={{ id: r.id, version: r.version, path: r.path, pathSource: r.pathSource }}
                  spots={routeSpots.map((s) => ({
                    id: s.id,
                    name: s.shortName,
                    lat: s.lat,
                    lng: s.lng,
                    radiusM: s.radiusM,
                  }))}
                  canEdit={canEdit}
                />

                {canEdit && (
                  <details className="group">
                    <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
                      Edit name, spots and wait
                    </summary>
                    <div className="pt-2">
                      <RouteForm
                        w={workspace.slug}
                        spots={pickable}
                        names={names}
                        route={{
                          id: r.id,
                          version: r.version,
                          name: r.name,
                          spotIds: r.spotIds,
                          pathSource: r.pathSource,
                          plannedDwellS: r.plannedDwellS,
                        }}
                      />
                    </div>
                  </details>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">New route</CardTitle>
            <CardDescription>The path is generated from the road map when you save; adjust it after.</CardDescription>
          </CardHeader>
          <CardContent>
            <RouteForm w={workspace.slug} spots={pickable} names={names} />
          </CardContent>
        </Card>
      )}
    </main>
  );
}
