/**
 * svc-public: live positions for the attendee map (SPEC §6). No login; no actor.
 * Privacy: a vehicle shows only while it is on an active shift (service_vehicles now) of a public service running
 * (service-days.ts: today, or yesterday's cross-midnight run, minus cancelled days), is active, was resolved to that
 * service by ingest, and sight() says "live": a fix ≤ 5 min old (sight.ts LIVE_MS), at a stop or en route. Ingest
 * marks a vehicle "offline" after 2 min; sight() rebuilds its stop or leg, so the map keeps it exactly as long as
 * the text does. "parked" (last seen inside a stop 5-15 min ago, "may still be there") is a guess, not a position,
 * so it is deliberately not drawn; neither are lost or hidden vehicles, off duty, between shifts or retired ones
 * (a driver going home must not be on the map). No lateness anywhere.
 * Exception, still only for those same on-shift vehicles: a vehicle that went silent in a leg known to have no
 * mobile signal (sight "predicted") is drawn at its estimated place on the route, with `estimate` set, until the
 * prediction expires (sight.ts); the client shows it faded with "No signal · estimated". A guess on a break is not drawn.
 */
import { istDate, istHHMM, type LatLng, pathLengthM } from "@eci-shuttle/shared";
import { legOf } from "@eci-shuttle/shared/geo/legOf";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import {
  legStats,
  routes,
  serviceExceptions,
  services,
  serviceVehicles,
  spots,
  vehicleState,
  vehicles,
  workspaces,
} from "@/db/schema";
import { activeBreaks } from "../catalog/breaks";
import { ServiceError } from "../kernel";
import { loadDeadZones } from "../signal/dead-zones";
import { predictLegS, routeLegs } from "./leg-estimate";
import { headingAlongPath, legFraction } from "./map-geo";
import { pointAtAlong, predictRoute } from "./predict";
import { addDays, serviceDaysInPlay } from "./service-days";
import { type PredictRoute, sight } from "./sight";

const Id = z.uuid();
const LatLngZ = z.object({ lat: z.number(), lng: z.number() });

export const PublicMapSpot = z.object({
  id: Id,
  name: z.string(),
  shortName: z.string(),
  lat: z.number(),
  lng: z.number(),
});
export type PublicMapSpot = z.infer<typeof PublicMapSpot>;

export const PublicMapRoute = z.object({
  id: Id,
  name: z.string(),
  colour: z.string().nullable(),
  /** ordered spot ids; a loop repeats the first at the end */
  spotIds: z.array(Id),
  path: z.array(LatLngZ),
  spotPathIdx: z.array(z.number().int()),
  lengthM: z.number().nonnegative(),
  /** learned typical seconds per leg (spotIds[i] → [i+1]); 0 = not learned yet */
  legS: z.array(z.number().nonnegative()),
});
export type PublicMapRoute = z.infer<typeof PublicMapRoute>;

export const PublicVehicle = z.object({
  id: Id,
  name: z.string(),
  colour: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  phase: z.enum(["at_spot", "en_route"]),
  /** on a driver's break: shown with a ☕, no ETA */
  onBreak: z.boolean(),
  routeId: Id,
  atSpotId: Id.nullable(),
  nextSpotId: Id.nullable(),
  nextSpotName: z.string().nullable(),
  /** which leg of the route it is on (index into spotIds), and how far along it, 0..1 */
  legIndex: z.number().int().nonnegative().nullable(),
  legFraction: z.number().min(0).max(1).nullable(),
  /** direction of travel along the route, compass degrees; null at a stop */
  headingDeg: z.number().min(0).max(360).nullable(),
  /** metres along its route's path (the map glides it along the road); null when off the route */
  alongM: z.number().nonnegative().nullable(),
  /**
   * Set when this is a guess, not a fix: the vehicle is in a stretch with no mobile signal and (lat, lng, alongM,
   * legFraction) are estimated from its last fix. The client draws it faded, "No signal · estimated".
   */
  estimate: z.object({ reason: z.literal("no_signal"), lastSeenAt: z.iso.datetime() }).optional(),
  /** when it got to its stop / left its last one (ISO): the page shows a waiting shuttle's next departure from it */
  since: z.iso.datetime(),
  lastSeenS: z.number().int().nonnegative(),
});
export type PublicVehicle = z.infer<typeof PublicVehicle>;

export const PublicMap = z.object({
  generatedAt: z.iso.datetime(),
  spots: z.array(PublicMapSpot),
  routes: z.array(PublicMapRoute),
  vehicles: z.array(PublicVehicle),
});
export type PublicMap = z.infer<typeof PublicMap>;

/** The public map of a workspace at `now`: stops and routes of today's public services, and the vehicles allowed to show. */
export async function publicPositions(db: Db, workspaceId: string, now: Date): Promise<PublicMap> {
  const nowMs = now.getTime();
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new ServiceError("NOT_FOUND", "Workspace not found.");

  const all = await db
    .select()
    .from(services)
    .where(and(eq(services.workspaceId, workspaceId), eq(services.public, true), isNull(services.archivedAt)));
  const today = istDate(nowMs);
  const exRows = all.length
    ? await db
        .select()
        .from(serviceExceptions)
        .where(
          and(
            inArray(
              serviceExceptions.serviceId,
              all.map((s) => s.id),
            ),
            inArray(serviceExceptions.date, [addDays(today, -1), today]),
            eq(serviceExceptions.kind, "cancel_day"),
          ),
        )
    : [];
  const svcs = [
    ...new Map(
      serviceDaysInPlay(
        all,
        exRows.map((e) => ({ serviceId: e.serviceId, date: e.date, type: e.kind })),
        nowMs,
      ).map((d) => [d.svc.id, d.svc]),
    ).values(),
  ];
  const empty: PublicMap = { generatedAt: now.toISOString(), spots: [], routes: [], vehicles: [] };
  if (!svcs.length) return empty;

  const routeRows = await db
    .select()
    .from(routes)
    .where(and(inArray(routes.id, [...new Set(svcs.map((s) => s.routeId))]), isNull(routes.archivedAt)));
  const routeById = new Map(routeRows.map((r) => [r.id, r]));
  const spotIds = [...new Set(routeRows.flatMap((r) => r.spotIds))];
  const spotRows = spotIds.length
    ? await db
        .select()
        .from(spots)
        .where(and(inArray(spots.id, spotIds), isNull(spots.archivedAt)))
    : [];
  const spotById = new Map(spotRows.map((s) => [s.id, s]));
  // spots in the order they come along the routes
  const orderedSpots: PublicMapSpot[] = [];
  for (const r of routeRows)
    for (const id of r.spotIds) {
      const s = spotById.get(id);
      if (s && !orderedSpots.some((x) => x.id === id))
        orderedSpots.push({ id: s.id, name: s.name, shortName: s.shortName, lat: s.lat, lng: s.lng });
    }

  const colourOf = new Map<string, string | null>();
  for (const s of svcs) if (!colourOf.has(s.routeId)) colourOf.set(s.routeId, s.colour);
  const outRoutes: PublicMapRoute[] = routeRows.map((r) => ({
    id: r.id,
    name: r.name,
    colour: colourOf.get(r.id) ?? null,
    spotIds: r.spotIds,
    path: r.path,
    spotPathIdx: r.spotPathIdx,
    lengthM: Math.round(pathLengthM(r.path)),
    legS: r.spotIds.slice(1).map((_, i) => r.typicalLegS[i] ?? 0),
  }));

  const zones = await loadDeadZones(db, workspaceId);
  const stats = zones.length ? await db.select().from(legStats).where(eq(legStats.workspaceId, workspaceId)) : [];
  const hour = Number(istHHMM(nowMs).slice(0, 2));
  const predictBy = new Map<string, PredictRoute>();
  for (const r of routeRows) {
    const svc = svcs.find((x) => x.routeId === r.id);
    // the same leg times as the answer's ETA, so the van and the minutes agree and expire together
    const p = predictRoute(r, zones, svc ? predictLegS(routeLegs(stats, svc, r, hour)) : []);
    if (p) predictBy.set(r.id, p);
  }
  const onBreak = await activeBreaks(db, workspaceId, now);
  const rows = await db
    .select({ serviceId: serviceVehicles.serviceId, vehicle: vehicles, state: vehicleState })
    .from(serviceVehicles)
    .innerJoin(vehicles, eq(vehicles.id, serviceVehicles.vehicleId))
    .innerJoin(vehicleState, eq(vehicleState.vehicleId, vehicles.id))
    .where(
      and(
        eq(serviceVehicles.workspaceId, workspaceId),
        inArray(
          serviceVehicles.serviceId,
          svcs.map((s) => s.id),
        ),
        lte(serviceVehicles.startsAt, now),
        gt(serviceVehicles.endsAt, now),
        eq(vehicles.active, true),
      ),
    );
  const svcById = new Map(svcs.map((s) => [s.id, s]));
  const out: PublicVehicle[] = [];
  for (const r of rows) {
    if (r.state.serviceId !== r.serviceId) continue;
    // live per sight(): a fix ≤ 5 min old; an "offline" state is rebuilt to the stop or leg it had at its last ping
    const routeId = svcById.get(r.serviceId)?.routeId ?? "";
    const seen = sight(r.state, nowMs, predictBy.get(routeId));
    if (seen.kind === "predicted") {
      const route = routeById.get(routeId);
      const e = seen.estimate;
      const at = route && pointAtAlong(route.path, e.alongM);
      if (!route || !at || onBreak.has(r.vehicle.id) || out.some((v) => v.id === r.vehicle.id)) continue;
      const lastAt = seen.last.at;
      out.push({
        id: r.vehicle.id,
        name: r.vehicle.name,
        colour: r.vehicle.colour,
        lat: at.lat,
        lng: at.lng,
        phase: "en_route",
        onBreak: false,
        routeId: route.id,
        atSpotId: null,
        nextSpotId: e.toSpotId,
        nextSpotName: spotById.get(e.toSpotId)?.shortName ?? null,
        legIndex: e.legIndex,
        legFraction: legFraction(route, e.legIndex, e.alongM),
        headingDeg: headingAlongPath(route.path, e.alongM),
        alongM: e.alongM,
        estimate: { reason: "no_signal", lastSeenAt: new Date(lastAt).toISOString() },
        since: new Date(seen.state.since.getTime() > 0 ? seen.state.since.getTime() : lastAt).toISOString(),
        lastSeenS: Math.max(0, Math.round(seen.ageMs / 1000)),
      });
      continue;
    }
    if (seen.kind !== "live") continue;
    const s = seen.state;
    if (s.phase !== "at_spot" && s.phase !== "en_route") continue;
    if (s.lat === null || s.lng === null || !s.lastPingAt) continue;
    if (out.some((v) => v.id === r.vehicle.id)) continue; // two overlapping shifts on public services
    const route = routeById.get(svcById.get(r.serviceId)?.routeId ?? "");
    if (!route) continue;
    const legIndex =
      s.phase === "en_route" && s.nextSpotId
        ? legOf(route, { spotId: s.spotId, nextSpotId: s.nextSpotId, alongM: s.alongM })
        : -1;
    const fraction = legIndex >= 0 ? legFraction(route, legIndex, s.alongM) : null;
    out.push({
      id: r.vehicle.id,
      name: r.vehicle.name,
      colour: r.vehicle.colour,
      lat: s.lat,
      lng: s.lng,
      phase: s.phase,
      onBreak: onBreak.has(r.vehicle.id),
      routeId: route.id,
      atSpotId: s.phase === "at_spot" ? s.spotId : null,
      nextSpotId: s.nextSpotId,
      nextSpotName: s.nextSpotId ? (spotById.get(s.nextSpotId)?.shortName ?? null) : null,
      legIndex: legIndex >= 0 ? legIndex : null,
      legFraction: fraction,
      headingDeg: s.phase === "en_route" && s.alongM !== null ? headingAlongPath(route.path, s.alongM) : null,
      alongM: s.offRoute || s.alongM === null ? null : Math.max(0, s.alongM),
      since: s.since.toISOString(),
      lastSeenS: Math.max(0, Math.round((nowMs - s.lastPingAt.getTime()) / 1000)),
    });
  }
  return { generatedAt: now.toISOString(), spots: orderedSpots, routes: outRoutes, vehicles: out };
}

export type { LatLng };
