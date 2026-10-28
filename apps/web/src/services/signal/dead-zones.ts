/**
 * svc-signal: legs of a route with no mobile signal ("dead zones"), e.g. Circle ↔ Namaka.
 * Shared interface for three parallel workstreams (owner of the implementation: the detection workstream):
 * - detection: fills `loadDeadZones` from data (Android pings that arrived late: received_at − recorded_at) plus
 *   admin overrides, and learns the leg's travel time from trips whose fixes were backfilled.
 * - prediction: services/public (sight / status / positions) consumes `loadDeadZones` + `predictAlong`.
 * - client: renders a PublicVehicle whose `estimate` is set as a faded, "no signal" van.
 * Until detection lands, `loadDeadZones` returns [] so nothing changes in production.
 */
import type { Db } from "@/db";

/** One leg of a route (route.spotIds[legIndex] → route.spotIds[legIndex + 1]) known to have no signal. */
export type DeadZone = {
  routeId: string;
  /** index k: the leg from spotIds[k] to spotIds[k + 1] */
  legIndex: number;
  fromSpotId: string;
  toSpotId: string;
  /** metres along the route path where the no-signal stretch starts / ends (within the leg); null = whole leg */
  startAlongM: number | null;
  endAlongM: number | null;
  /** "manual" = marked by an admin; "detected" = found from late-arriving pings */
  source: "manual" | "detected";
  /** typical travel time of the whole leg in seconds (learned; null = unknown → use the leg estimate) */
  typicalLegS: number | null;
};

/** Dead zones of every route in a workspace. No actor: callers check access (public read is fine). */
export async function loadDeadZones(_db: Db, _workspaceId: string): Promise<DeadZone[]> {
  return [];
}
