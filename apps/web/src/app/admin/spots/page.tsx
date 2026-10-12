import type { Metadata } from "next";
import { SpotsAdmin } from "@/components/admin/spots/spots-admin";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { listSpots } from "@/services/catalog/spots";
import { can } from "@/services/kernel";

/** admin-spots (SPEC §7): add with a map pin, geofence radius, rename, archive. Components live in components/admin/spots/. */
export const metadata: Metadata = { title: "Spots" };

export default async function SpotsPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const { actor, workspace } = await requireAdmin({ w });
  const spots = await listSpots(db(), actor, { workspaceId: workspace.id, includeArchived: true });
  return (
    <SpotsAdmin
      w={workspace.slug}
      canEdit={can(actor, workspace.id, "ops")}
      spots={spots.map((s) => ({
        id: s.id,
        name: s.name,
        shortName: s.shortName,
        lat: s.lat,
        lng: s.lng,
        radiusM: s.radiusM,
        notes: s.notes,
        archivedAt: s.archivedAt,
        version: s.version,
      }))}
    />
  );
}
