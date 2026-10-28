/**
 * Nightly dead-zone detection (called from the learning job): projects the last WINDOW_DAYS of Android pings of
 * each trip onto its route leg, runs the pure detection (./detect) and stores the result as `detected` entries in
 * routes.no_signal_legs. Derived data like leg_stats: no audit row, no version bump (an open MCP proposal stays valid).
 * Manual entries are never touched; legs with an admin's "has signal" override get no detected stretch.
 */
import { isDeepStrictEqual } from "node:util";
import { type LatLng, pathLengthM, projectOntoPath } from "@eci-shuttle/shared";
import { and, between, eq, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import type { Db } from "@/db";
import { devices, type NoSignalLeg, pings, routes, trips } from "@/db/schema";
import type { Route } from "@/db/types";
import { isHasSignalMark } from "./dead-zones";
import { type DetectLeg, type DetectPing, detectStretches } from "./detect";

/** how far back pings are looked at (same window as the leg stats) */
export const WINDOW_DAYS = 7;
/** a ping further than this from its leg's path is off-route noise, not evidence */
export const MAX_OFFSET_M = 60;
/** a fix less accurate than this can land in the wrong bin */
export const MAX_ACCURACY_M = 100;
/** phones that share a live location or report through Traccar: no offline backlog, so no evidence either way */
const NON_BACKFILLING_APPS = ["telegram", "traccar"];

const DAY_MS = 86_400_000;
const istDay = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

type Geometry = { legs: (DetectLeg & { sub: LatLng[]; fromSpotId: string; toSpotId: string })[] };

/** Legs of a route with their extent along the whole path; null when the route has no usable path. */
function geometry(route: Route): Geometry | null {
  const { path, spotPathIdx: idx, spotIds } = route;
  if (path.length < 2 || idx.length !== spotIds.length) return null;
  return {
    legs: spotIds.slice(0, -1).map((fromSpotId, legIndex) => {
      const a = idx[legIndex] as number;
      const b = idx[legIndex + 1] as number;
      const startM = pathLengthM(path.slice(0, a + 1));
      return {
        legIndex,
        fromSpotId,
        toSpotId: spotIds[legIndex + 1] as string,
        sub: path.slice(a, b + 1),
        startM,
        endM: startM + pathLengthM(path.slice(a, b + 1)),
      };
    }),
  };
}

// deep equality: jsonb hands keys back in its own order
const sameLegs = (a: NoSignalLeg[], b: NoSignalLeg[]) => isDeepStrictEqual(a, b);

/** Recomputes the detected stretches of every active route in a workspace. Returns how many stretches are stored. */
export async function recomputeDeadZones(db: Db, workspaceId: string, now: Date): Promise<{ detected: number }> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const routeRows = await db
    .select()
    .from(routes)
    .where(and(eq(routes.workspaceId, workspaceId), isNull(routes.archivedAt)));

  // every ping of an Android phone inside one of the window's trips; the trip tells the route and the leg
  const rows = await db
    .select({
      tripId: trips.id,
      routeId: trips.routeId,
      fromSpotId: trips.fromSpotId,
      toSpotId: trips.toSpotId,
      departedAt: trips.departedAt,
      deviceId: pings.deviceId,
      lat: pings.lat,
      lng: pings.lng,
      recordedAt: pings.recordedAt,
      receivedAt: pings.receivedAt,
    })
    .from(trips)
    .innerJoin(
      pings,
      and(
        eq(pings.vehicleId, trips.vehicleId),
        between(pings.recordedAt, trips.departedAt, trips.arrivedAt),
        eq(pings.workspaceId, trips.workspaceId),
      ),
    )
    .innerJoin(devices, eq(devices.id, pings.deviceId))
    .where(
      and(
        eq(trips.workspaceId, workspaceId),
        isNotNull(trips.routeId),
        isNotNull(trips.toSpotId),
        isNotNull(trips.arrivedAt),
        between(trips.departedAt, since, now),
        or(isNull(devices.appVersion), notInArray(devices.appVersion, NON_BACKFILLING_APPS)),
        between(pings.accuracy, 0, MAX_ACCURACY_M),
      ),
    );

  let total = 0;
  for (const route of routeRows) {
    const geo = geometry(route);
    const mine = rows.filter((r) => r.routeId === route.id);
    const evidence: DetectPing[] = [];
    if (geo) {
      const byTrip = Map.groupBy(mine, (r) => r.tripId);
      for (const [tripId, ps] of byTrip) {
        const first = ps[0] as (typeof ps)[number];
        const candidates = geo.legs.filter((l) => l.fromSpotId === first.fromSpotId && l.toSpotId === first.toSpotId);
        // a loop can visit the same two spots twice: take the leg the trip's fixes lie closest to
        const scored = candidates.map((leg) => {
          const proj = ps.map((p) => projectOntoPath(leg.sub, { lat: p.lat, lng: p.lng }));
          return { leg, proj, score: proj.reduce((s, x) => s + x.offsetM, 0) / proj.length };
        });
        const best = scored.sort((a, b) => a.score - b.score)[0];
        if (!best) continue;
        ps.forEach((p, i) => {
          const proj = best.proj[i] as (typeof best.proj)[number];
          if (proj.offsetM > MAX_OFFSET_M) return;
          evidence.push({
            tripId,
            day: istDay(first.departedAt.getTime()),
            deviceId: p.deviceId,
            legIndex: best.leg.legIndex,
            alongM: best.leg.startM + proj.alongM,
            lateS: (p.receivedAt.getTime() - p.recordedAt.getTime()) / 1000,
          });
        });
      }
    }
    const hasSignal = new Set(route.noSignalLegs.filter(isHasSignalMark).map((e) => e.legIndex));
    const found: NoSignalLeg[] = geo
      ? detectStretches(
          evidence,
          geo.legs.map(({ legIndex, startM, endM }) => ({ legIndex, startM, endM })),
        ).map((s) => ({
          legIndex: s.legIndex,
          source: "detected",
          startAlongM: Math.round(s.startAlongM),
          endAlongM: Math.round(s.endAlongM),
          trips: s.trips,
          days: s.days,
        }))
      : [];
    total += found.filter((e) => !hasSignal.has(e.legIndex)).length;

    // re-read under a row lock: an admin toggling a manual entry meanwhile must not be lost
    await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(routes).where(eq(routes.id, route.id)).for("update");
      if (!cur) return;
      // an admin's "has signal" override on a leg: its detected stretches are not stored again
      const clear = new Set(cur.noSignalLegs.filter(isHasSignalMark).map((e) => e.legIndex));
      const next = [
        ...cur.noSignalLegs.filter((e) => e.source === "manual"),
        ...found.filter((e) => !clear.has(e.legIndex)),
      ].sort((a, b) => a.legIndex - b.legIndex || (a.startAlongM ?? 0) - (b.startAlongM ?? 0));
      if (!sameLegs(cur.noSignalLegs, next))
        await tx.update(routes).set({ noSignalLegs: next }).where(eq(routes.id, route.id));
    });
  }
  return { detected: total };
}
