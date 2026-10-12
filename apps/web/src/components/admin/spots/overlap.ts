/** admin-spots: live geofence-overlap warning while a pin is placed. Pure, runs in the browser. */
import type { LatLng } from "@eci-shuttle/shared";

/** Mandrem, Goa: where the map opens when there are no spots yet. */
export const DEFAULT_CENTER: LatLng = { lat: 15.656, lng: 73.715 };

// ponytail: local haversine because shared geo distanceM is a stub in this base; swap to it once merged.
export function distanceM(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

type Fence = LatLng & { radiusM: number };

/**
 * One warning per other non-archived spot whose circle overlaps this one (centres closer than the sum of radii).
 * Overlap is allowed (the nearest centre wins at ingest), so it only warns.
 */
export function overlapWarnings(
  spot: Fence & { id?: string },
  others: (Fence & { id: string; name: string; archivedAt: Date | string | null })[],
): string[] {
  return others
    .filter((o) => o.id !== spot.id && !o.archivedAt)
    .map((o) => ({ o, d: distanceM(spot, o) }))
    .filter(({ o, d }) => d < spot.radiusM + o.radiusM)
    .map(
      ({ o, d }) =>
        `Overlaps ${o.name} (${Math.round(d)} m apart). A shuttle in both circles counts as at the nearer one.`,
    );
}
