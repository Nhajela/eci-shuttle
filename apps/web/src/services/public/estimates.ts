/**
 * svc-public: estimated places for ops views (staff map, live board). Like the public map, a vehicle that went
 * silent in a leg with no mobile signal (sight "predicted") gets an estimated place on the route; unlike it, no
 * shift or privacy rule applies (staff see every vehicle). Always marked as an estimate by the callers.
 */
import { istHHMM, type LatLng } from "@eci-shuttle/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { legStats, routes, services } from "@/db/schema";
import type { VehicleState } from "@/db/types";
import { loadDeadZones } from "../signal/dead-zones";
import { predictLegS, routeLegs } from "./leg-estimate";
import { pointAtAlong, predictRoute } from "./predict";
import { type PredictRoute, sight } from "./sight";

export type VehicleEstimate = LatLng & {
  alongM: number;
  legIndex: number;
  fromSpotId: string;
  toSpotId: string;
  /** when its last real fix was */
  lastSeenAt: Date;
  /** when it usually gets to toSpotId */
  arrivesAt: Date;
};

/** Estimated places by vehicle id, for those of `states` that are silent in a dead zone at `now`. Empty when no dead zones. */
export async function estimateVehicles(
  db: Db,
  workspaceId: string,
  states: VehicleState[],
  now: Date,
): Promise<Map<string, VehicleEstimate>> {
  const out = new Map<string, VehicleEstimate>();
  const withService = states.filter((s) => s.serviceId && s.lastPingAt);
  if (!withService.length) return out;
  const zones = await loadDeadZones(db, workspaceId);
  if (!zones.length) return out;
  const svcRows = await db
    .select({ id: services.id, routeId: services.routeId, kind: services.kind })
    .from(services)
    .where(
      and(
        eq(services.workspaceId, workspaceId),
        inArray(services.id, [...new Set(withService.map((s) => s.serviceId as string))]),
      ),
    );
  const routeIds = [...new Set(svcRows.map((r) => r.routeId))];
  const routeRows = routeIds.length ? await db.select().from(routes).where(inArray(routes.id, routeIds)) : [];
  const routeById = new Map(routeRows.map((r) => [r.id, r]));
  const routeOfService = new Map(svcRows.map((r) => [r.id, r.routeId]));
  const stats = await db.select().from(legStats).where(eq(legStats.workspaceId, workspaceId));
  const hour = Number(istHHMM(now.getTime()).slice(0, 2));
  const predictBy = new Map<string, PredictRoute>();
  for (const r of routeRows) {
    const svc = svcRows.find((x) => x.routeId === r.id);
    const p = predictRoute(r, zones, svc ? predictLegS(routeLegs(stats, svc, r, hour)) : []);
    if (p) predictBy.set(r.id, p);
  }
  for (const s of withService) {
    const routeId = routeOfService.get(s.serviceId as string);
    const seen = routeId ? sight(s, now.getTime(), predictBy.get(routeId)) : null;
    const route = routeId ? routeById.get(routeId) : undefined;
    if (seen?.kind !== "predicted" || !route) continue;
    const at = pointAtAlong(route.path, seen.estimate.alongM);
    if (!at) continue;
    out.set(s.vehicleId, {
      ...at,
      alongM: seen.estimate.alongM,
      legIndex: seen.estimate.legIndex,
      fromSpotId: seen.estimate.fromSpotId,
      toSpotId: seen.estimate.toSpotId,
      lastSeenAt: new Date(seen.last.at),
      arrivesAt: new Date(seen.estimate.arrivesAtMs),
    });
  }
  return out;
}
