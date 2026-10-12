/**
 * svc-ingest: pings → vehicle_state, dwells, trips, departure_matches (SPEC §3, §6a pipeline). Derived data: not
 * audited. Called by devices/sync inside its transaction.
 */
import {
  type EtaLeg,
  type EtaVehicle,
  etaToSpot,
  expandServiceDepartures,
  GEOFENCE_MAX_ACCURACY_M,
  type GeofenceSpot,
  geofenceStep,
  INITIAL_GEOFENCE_STATE,
  IST_OFFSET_MIN,
  type LatLng,
  legEstimate,
  matchDepartures,
  type Phase,
  type Ping,
  pathLengthM,
  projectOntoPath,
  type ServiceDef,
  type ServiceExceptionDef,
  type TripQuality,
  trackingWindows,
  type Weekday,
} from "@eci-shuttle/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "@/db";
import {
  departureMatches,
  deviceAssignments,
  devices,
  dwells,
  pings as pingsTable,
  routes,
  serviceExceptions,
  services,
  serviceVehicles,
  spots,
  trips,
  vehicleState,
} from "@/db/schema";
import type { PingRow, Route, Service, Trip, VehicleState } from "@/db/types";
import { ServiceError } from "@/services/kernel";

export type IngestResult = {
  /** pings stored (duplicates on (device_id, recorded_at) skipped) */
  inserted: number;
  /** trips closed by this batch: the caller passes them to learning.onTripClosed */
  closedTrips: Trip[];
  /** vehicles whose state changed: the caller checks arrival alerts for them */
  vehicleIds: string[];
};

const GAP_MS = 2 * 60_000;
const OFF_ROUTE_M = 150;
const OFF_ROUTE_MS = 60_000;
const OFFLINE_MS = 2 * 60_000;
const MATCH_TOL_MS = 25 * 60_000;
const DAY_MS = 86_400_000;

const istDate = (ms: number) => new Date(ms + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
const istHour = (ms: number) => new Date(ms + IST_OFFSET_MIN * 60_000).getUTCHours();

type Fix = { at: number; lat: number; lng: number };
const goodFixes = (rows: PingRow[]): Fix[] =>
  rows
    .filter((p) => p.accuracy <= GEOFENCE_MAX_ACCURACY_M)
    .map((p) => ({ at: p.recordedAt.getTime(), lat: p.lat, lng: p.lng }));

/** Longest and trailing runs of fixes > 150 m off the path, in ms (first to last off-route fix of the run). */
export function offRouteRuns(fixes: Fix[], path: LatLng[]): { longest: number; current: number } {
  let start: number | null = null;
  let longest = 0;
  let current = 0;
  for (const f of fixes) {
    if (path.length > 1 && projectOntoPath(path, f).offsetM > OFF_ROUTE_M) {
      start ??= f.at;
      current = f.at - start;
      longest = Math.max(longest, current);
    } else {
      start = null;
      current = 0;
    }
  }
  return { longest, current };
}

/** gap: > 2 min without fixes anywhere between departure and arrival; off_route: > 150 m off for > 1 min. */
export function tripQuality(fixes: Fix[], path: LatLng[], departedAt: number, arrivedAt: number): TripQuality {
  const times = [departedAt, ...fixes.map((f) => f.at), arrivedAt];
  if (times.some((t, i) => i > 0 && t - times[i - 1] > GAP_MS)) return "gap";
  return offRouteRuns(fixes, path).longest > OFF_ROUTE_MS ? "off_route" : "clean";
}

const serviceDef = (s: Service): ServiceDef => ({ ...s, daysOfWeek: s.daysOfWeek as Weekday[] });

/** Services, routes and tracking windows of the given vehicles (windows = trackingWindows over service_vehicles). */
async function scheduleFor(db: Db, workspaceId: string, vehicleIds: string[], from: number, to: number) {
  const svs = vehicleIds.length
    ? await db
        .select()
        .from(serviceVehicles)
        .where(and(eq(serviceVehicles.workspaceId, workspaceId), inArray(serviceVehicles.vehicleId, vehicleIds)))
    : [];
  const serviceIds = [...new Set(svs.map((s) => s.serviceId))];
  const svcs = serviceIds.length ? await db.select().from(services).where(inArray(services.id, serviceIds)) : [];
  const exs: ServiceExceptionDef[] = serviceIds.length
    ? (await db.select().from(serviceExceptions).where(inArray(serviceExceptions.serviceId, serviceIds))).map((e) => ({
        serviceId: e.serviceId,
        date: e.date,
        type: e.kind,
        departure: e.departure,
        minutes: e.minutes,
      }))
    : [];
  const routeIds = [...new Set(svcs.map((s) => s.routeId))];
  const rts = routeIds.length ? await db.select().from(routes).where(inArray(routes.id, routeIds)) : [];
  const windows = trackingWindows(
    svs.map((s) => ({ ...s, startsAt: s.startsAt.getTime(), endsAt: s.endsAt.getTime() })),
    svcs.map(serviceDef),
    exs,
    from,
    to,
  );
  const serviceAt = (vehicleId: string, t: number) =>
    windows.find((w) => w.vehicleId === vehicleId && w.startsAt <= t && t < w.endsAt)?.serviceIds[0] ?? null;
  return {
    services: new Map(svcs.map((s) => [s.id, s])),
    routes: new Map(rts.map((r) => [r.id, r])),
    exceptions: exs,
    serviceAt,
  };
}
type Schedule = Awaited<ReturnType<typeof scheduleFor>>;

/**
 * Store pings (resolving vehicle_id from the device's assignment at each recorded_at), then, for the assigned
 * vehicle, in recorded_at order: geofenceStep (shared-geo) per fix → dwells (arrived/departed), trips
 * (from → to spot, quality clean / gap (> 2 min without fixes) / off_route (> 150 m off the path for > 1 min)),
 * departure_matches for the service running (matchDepartures on that day's planned vs actual departures),
 * vehicle_state (phase, spot / next spot, eta_s via etaToSpot, last_ping_at, off_route, geofence state).
 * Pings older than the vehicle's last processed fix are stored but don't rewind state.
 */
export async function ingestPings(
  db: Db,
  input: { workspaceId: string; deviceId: string; pings: Ping[] },
  now: Date,
): Promise<IngestResult> {
  const { workspaceId, deviceId } = input;
  return db.transaction(async (tx) => {
    const [device] = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.workspaceId, workspaceId)));
    if (!device) throw new ServiceError("NOT_FOUND", "Phone not found.");
    if (!input.pings.length) return { inserted: 0, closedTrips: [], vehicleIds: [] };

    const assigns = await tx.select().from(deviceAssignments).where(eq(deviceAssignments.deviceId, deviceId));
    const vehicleAt = (t: number) =>
      assigns.find((a) => a.startsAt.getTime() <= t && (a.endsAt == null || t < a.endsAt.getTime()))?.vehicleId ?? null;
    const rows = await tx
      .insert(pingsTable)
      .values(
        input.pings.map((p) => ({
          ...p,
          workspaceId,
          deviceId,
          vehicleId: vehicleAt(p.recordedAt),
          recordedAt: new Date(p.recordedAt),
          receivedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning();

    const byVehicle = Map.groupBy(
      rows.filter((r) => r.vehicleId),
      (r) => r.vehicleId as string,
    );
    const closedTrips: Trip[] = [];
    const vehicleIds: string[] = [];
    for (const [vehicleId, vRows] of byVehicle) {
      const closed = await processVehicle(tx, workspaceId, vehicleId, vRows, now);
      if (!closed) continue;
      vehicleIds.push(vehicleId);
      closedTrips.push(...closed);
    }
    return { inserted: rows.length, closedTrips, vehicleIds };
  });
}

/** Advance one vehicle by its new pings. Returns the trips it closed, or null when nothing newer than its state. */
async function processVehicle(
  tx: Db,
  workspaceId: string,
  vehicleId: string,
  rows: PingRow[],
  now: Date,
): Promise<Trip[] | null> {
  await tx.insert(vehicleState).values({ workspaceId, vehicleId, since: now }).onConflictDoNothing();
  const [st] = await tx.select().from(vehicleState).where(eq(vehicleState.vehicleId, vehicleId)).for("update");
  const cutoff = st.lastPingAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  // late pings are stored but never rewind live state
  const fresh = rows.filter((r) => r.recordedAt.getTime() > cutoff).sort((a, b) => +a.recordedAt - +b.recordedAt);
  if (!fresh.length) return null;
  const firstAt = fresh[0].recordedAt.getTime();
  const lastAt = fresh[fresh.length - 1].recordedAt.getTime();

  const sched = await scheduleFor(tx, workspaceId, [vehicleId], firstAt - DAY_MS, lastAt + DAY_MS);
  const spotRows = await tx
    .select()
    .from(spots)
    .where(and(eq(spots.workspaceId, workspaceId), isNull(spots.archivedAt)));
  const gSpots: GeofenceSpot[] = spotRows.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, radiusM: s.radiusM }));
  let openTrip: Trip | undefined;
  [openTrip] = await tx
    .select()
    .from(trips)
    .where(and(eq(trips.vehicleId, vehicleId), isNull(trips.arrivedAt)))
    .orderBy(desc(trips.departedAt))
    .limit(1);

  let gf = st.geofence ?? INITIAL_GEOFENCE_STATE;
  let lastEventAt: number | null = null;
  const closed: Trip[] = [];
  for (const p of fresh) {
    const step = geofenceStep(gf, { at: p.recordedAt.getTime(), lat: p.lat, lng: p.lng, accuracy: p.accuracy }, gSpots);
    gf = step.state;
    for (const e of step.events) {
      lastEventAt = e.at;
      const at = new Date(e.at);
      const serviceId = sched.serviceAt(vehicleId, e.at);
      if (e.kind === "arrived") {
        await tx.insert(dwells).values({ workspaceId, vehicleId, spotId: e.spotId, serviceId, arrivedAt: at });
        if (openTrip) {
          closed.push(await closeTrip(tx, openTrip, e.spotId, e.at, sched));
          openTrip = undefined;
        }
      } else {
        await tx
          .update(dwells)
          .set({ departedAt: at, ...(serviceId && { serviceId }) })
          .where(and(eq(dwells.vehicleId, vehicleId), eq(dwells.spotId, e.spotId), isNull(dwells.departedAt)));
        const svc = serviceId ? sched.services.get(serviceId) : undefined;
        [openTrip] = await tx
          .insert(trips)
          .values({ workspaceId, vehicleId, serviceId, routeId: svc?.routeId, fromSpotId: e.spotId, departedAt: at })
          .returning();
        if (svc) await matchDay(tx, svc, sched, e.spotId, e.at, now);
      }
    }
  }

  // live state from the newest fix
  const lastGood = fresh.filter((f) => f.accuracy <= GEOFENCE_MAX_ACCURACY_M).at(-1);
  const serviceId = sched.serviceAt(vehicleId, lastAt);
  const route = serviceId ? sched.routes.get(sched.services.get(serviceId)?.routeId as string) : undefined;
  const atSpot = gf.insideSpotId != null;
  const spotId = gf.insideSpotId ?? openTrip?.fromSpotId ?? null;
  const phase: Phase = !serviceId ? "off_duty" : atSpot ? "at_spot" : "en_route";
  const live =
    route && spotId ? await routeProgress(route, spotId, atSpot, gf.enteredAt ?? lastAt, lastGood, now) : null;
  const since = lastEventAt != null ? new Date(lastEventAt) : phase !== st.phase ? fresh[0].recordedAt : st.since;
  await tx
    .update(vehicleState)
    .set({
      serviceId,
      phase,
      spotId,
      nextSpotId: live?.nextSpotId ?? null,
      since,
      etaS: live?.etaS ?? null,
      lastPingAt: new Date(lastAt),
      lat: lastGood?.lat ?? st.lat,
      lng: lastGood?.lng ?? st.lng,
      alongM: live?.alongM ?? null,
      offRoute: !atSpot && route ? await offRouteNow(tx, vehicleId, route.path, lastAt) : false,
      geofence: gf,
      updatedAt: now,
    })
    .where(eq(vehicleState.vehicleId, vehicleId));
  return closed;
}

async function closeTrip(tx: Db, trip: Trip, toSpotId: string, at: number, sched: Schedule): Promise<Trip> {
  const departedAt = trip.departedAt.getTime();
  const fixes = goodFixes(
    await tx
      .select()
      .from(pingsTable)
      .where(
        and(
          eq(pingsTable.vehicleId, trip.vehicleId),
          gte(pingsTable.recordedAt, trip.departedAt),
          lte(pingsTable.recordedAt, new Date(at)),
        ),
      )
      .orderBy(asc(pingsTable.recordedAt)),
  );
  const path = (trip.routeId && sched.routes.get(trip.routeId)?.path) || [];
  const [row] = await tx
    .update(trips)
    .set({
      toSpotId,
      arrivedAt: new Date(at),
      durationS: Math.round((at - departedAt) / 1000),
      quality: tripQuality(fixes, path, departedAt, at),
    })
    .where(eq(trips.id, trip.id))
    .returning();
  return row;
}

/** Live off-route: the trailing run of the last 10 min of fixes is > 150 m off the path for > 1 min. */
async function offRouteNow(tx: Db, vehicleId: string, path: LatLng[], lastAt: number): Promise<boolean> {
  const recent = await tx
    .select()
    .from(pingsTable)
    .where(
      and(
        eq(pingsTable.vehicleId, vehicleId),
        gte(pingsTable.recordedAt, new Date(lastAt - 10 * 60_000)),
        lte(pingsTable.recordedAt, new Date(lastAt)),
      ),
    )
    .orderBy(asc(pingsTable.recordedAt));
  return offRouteRuns(goodFixes(recent), path).current > OFF_ROUTE_MS;
}

/**
 * Next spot, metres along the path and ETA to the next spot. Leg estimates are the day-1 baseline.
 * ponytail: baseline only; switch to learning.loadEstimates once it lands so eta_s uses learned leg/dwell times.
 */
async function routeProgress(
  route: Route,
  spotId: string,
  atSpot: boolean,
  since: number,
  fix: PingRow | undefined,
  now: Date,
): Promise<{ nextSpotId: string | null; etaS: number | null; alongM: number | null }> {
  const k = route.spotIds.indexOf(spotId);
  const nextSpotId = k >= 0 ? (route.spotIds[k + 1] ?? null) : null;
  const { path, spotPathIdx: idx, spotIds } = route;
  if (!nextSpotId || path.length < 2 || idx.length !== spotIds.length) return { nextSpotId, etaS: null, alongM: null };
  const nowMs = now.getTime();
  const opts = { hourBucket: istHour(nowMs), now: nowMs };
  const legPath = (i: number) => path.slice(idx[i], idx[i + 1] + 1);
  const legs: EtaLeg[] = spotIds.slice(1).map((to, i) => {
    const lengthM = pathLengthM(legPath(i));
    return { fromSpotId: spotIds[i], toSpotId: to, lengthM, estimate: legEstimate([], { ...opts, pathM: lengthM }) };
  });
  const dwellEst = legEstimate([], { ...opts, pathM: 0 });
  const alongLegM = !atSpot && fix ? projectOntoPath(legPath(k), fix).alongM : 0;
  const vehicle: EtaVehicle = atSpot
    ? { kind: "at_spot", spotIndex: k, since }
    : { kind: "en_route", legIndex: k, alongLegM };
  const eta = etaToSpot({
    legs,
    dwells: Object.fromEntries(spotIds.map((s) => [s, dwellEst])),
    vehicle,
    targetSpotId: nextSpotId,
    loop: spotIds[0] === spotIds[spotIds.length - 1],
    now: nowMs,
  });
  return {
    nextSpotId,
    etaS: eta ? Math.round(eta.seconds) : null,
    alongM: pathLengthM(path.slice(0, idx[k] + 1)) + alongLegM,
  };
}

/**
 * Re-match the service day's planned departures from the route's first spot against every actual departure
 * (dwells at that spot on that service). Passed planned departures with no match are written as missed.
 */
async function matchDay(tx: Db, svc: Service, sched: Schedule, spotId: string, at: number, now: Date) {
  const route = sched.routes.get(svc.routeId);
  if (route?.spotIds[0] !== spotId) return;
  // a departure after midnight may belong to the previous service day
  for (const date of new Set([istDate(at), istDate(at - DAY_MS)])) {
    const planned = expandServiceDepartures(serviceDef(svc), sched.exceptions, date);
    if (!planned.length) continue;
    const lo = planned[0].at - MATCH_TOL_MS;
    const hi = planned[planned.length - 1].at + MATCH_TOL_MS;
    if (at < lo || at > hi) continue;
    const actual = await tx
      .select()
      .from(dwells)
      .where(
        and(
          eq(dwells.serviceId, svc.id),
          eq(dwells.spotId, spotId),
          gte(dwells.departedAt, new Date(lo)),
          lte(dwells.departedAt, new Date(hi)),
        ),
      );
    const res = matchDepartures(
      planned.map((p) => ({ id: String(p.at), at: p.at })),
      actual.map((d) => ({ id: d.id, at: (d.departedAt as Date).getTime() })),
    );
    const key = { workspaceId: svc.workspaceId, serviceId: svc.id, spotId, date };
    for (const m of res.matches) {
      const plannedAt = new Date(Number(m.plannedId));
      const dwell = actual.find((d) => d.id === m.actualId);
      if (!dwell && plannedAt.getTime() + MATCH_TOL_MS > now.getTime()) {
        // not due yet: drop a match an earlier run made, if the re-match moved it
        await tx
          .delete(departureMatches)
          .where(
            and(
              eq(departureMatches.serviceId, svc.id),
              eq(departureMatches.spotId, spotId),
              eq(departureMatches.plannedAt, plannedAt),
            ),
          );
        continue;
      }
      const row = {
        actualAt: dwell?.departedAt ?? null,
        dwellId: dwell?.id ?? null,
        delayMin: m.delayMin,
        missed: m.missed,
        updatedAt: now,
      };
      await tx
        .insert(departureMatches)
        .values({ ...key, plannedAt, ...row })
        .onConflictDoUpdate({
          target: [departureMatches.serviceId, departureMatches.spotId, departureMatches.plannedAt],
          set: row,
        });
      if (dwell) await tx.update(dwells).set({ plannedDepartureAt: plannedAt }).where(eq(dwells.id, dwell.id));
    }
  }
}

/**
 * Mark vehicles offline (phase "offline") whose last ping is > 2 min old while inside a tracking window, and
 * "off_duty" outside windows. Called by the watchdog/windows jobs. Returns vehicles changed.
 */
export async function refreshPhases(db: Db, workspaceId: string, now: Date): Promise<string[]> {
  return db.transaction(async (tx) => {
    const t = now.getTime();
    const rows = await tx.select().from(vehicleState).where(eq(vehicleState.workspaceId, workspaceId)).for("update");
    const sched = await scheduleFor(
      tx,
      workspaceId,
      rows.map((r) => r.vehicleId),
      t - DAY_MS,
      t + DAY_MS,
    );
    const changed: string[] = [];
    for (const r of rows) {
      const serviceId = sched.serviceAt(r.vehicleId, t);
      const silent = !r.lastPingAt || t - r.lastPingAt.getTime() > OFFLINE_MS;
      const phase: Phase | null = !serviceId ? "off_duty" : silent ? "offline" : null;
      if (!phase || phase === r.phase) continue;
      await tx
        .update(vehicleState)
        .set({ phase, since: now, etaS: null, serviceId: phase === "off_duty" ? null : serviceId, updatedAt: now })
        .where(eq(vehicleState.vehicleId, r.vehicleId));
      changed.push(r.vehicleId);
    }
    return changed;
  });
}

/** All vehicle_state rows of a workspace (live board, public status). No actor: callers check access. */
export async function vehicleStates(db: Db, workspaceId: string): Promise<VehicleState[]> {
  return db.select().from(vehicleState).where(eq(vehicleState.workspaceId, workspaceId));
}
