import { randomUUID } from "node:crypto";
import type { Ping } from "@eci-shuttle/shared";
import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  departureMatches,
  deviceAssignments,
  devices,
  dwells,
  pings,
  routes,
  services,
  serviceVehicles,
  spots,
  trips,
  vehicleState,
  vehicles,
} from "@/db/schema";
import { ingestPings, refreshPhases, vehicleStates } from "./ingest";

const db = () => testDb();
/** IST wall clock on the test day → epoch ms */
const ist = (hhmmss: string) => Date.parse(`2026-10-13T${hhmmss}+05:30`);
const RIVA = { lat: 15.7, lng: 73.7 };
const CIRCLE = { lat: 15.71, lng: 73.7 };

const ping = (at: number, p: { lat: number; lng: number }, accuracy = 8): Ping => ({
  recordedAt: at,
  lat: p.lat,
  lng: p.lng,
  accuracy,
  speed: null,
  heading: null,
  battery: 80,
});
/** fixes every 10 s from `from` to `to` (inclusive), positions interpolated a → b */
function track(from: number, to: number, a: { lat: number; lng: number }, b = a): Ping[] {
  const out: Ping[] = [];
  for (let t = from; t <= to; t += 10_000) {
    const f = to === from ? 1 : (t - from) / (to - from);
    out.push(ping(t, { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f }));
  }
  return out;
}

/** Riva ↔ Circle on 13 Oct 2026, one vehicle with one phone, service 08:30–11:00 with departures 09:00 and 09:40. */
async function world(opts: { assign?: boolean; svFrom?: string; svTo?: string } = {}) {
  const ws = await makeWorkspace(db());
  const [riva, circle] = await db()
    .insert(spots)
    .values([
      { workspaceId: ws.id, name: "Riva", shortName: "Riva", ...RIVA, radiusM: 75 },
      { workspaceId: ws.id, name: "Circle", shortName: "Circle", ...CIRCLE, radiusM: 75 },
    ])
    .returning();
  const [route] = await db()
    .insert(routes)
    .values({
      workspaceId: ws.id,
      name: "Riva ↔ Circle",
      spotIds: [riva.id, circle.id, riva.id],
      path: [RIVA, CIRCLE, RIVA],
      spotPathIdx: [0, 1, 2],
    })
    .returning();
  const [service] = await db()
    .insert(services)
    .values({
      workspaceId: ws.id,
      name: "Regular",
      kind: "regular",
      routeId: route.id,
      validFrom: "2026-10-11",
      validTo: "2026-11-01",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "08:30",
      endTime: "11:00",
      pattern: { kind: "times", times: ["09:00", "09:40"] },
    })
    .returning();
  const [vehicle] = await db().insert(vehicles).values({ workspaceId: ws.id, name: "Bus 1" }).returning();
  const [device] = await db()
    .insert(devices)
    .values({ workspaceId: ws.id, label: "Phone 1", tokenHash: randomUUID() })
    .returning();
  if (opts.assign !== false)
    await db()
      .insert(deviceAssignments)
      .values({ workspaceId: ws.id, deviceId: device.id, vehicleId: vehicle.id, startsAt: new Date(ist("06:00:00")) });
  await db()
    .insert(serviceVehicles)
    .values({
      workspaceId: ws.id,
      serviceId: service.id,
      vehicleId: vehicle.id,
      startsAt: new Date(ist(opts.svFrom ?? "08:00:00")),
      endsAt: new Date(ist(opts.svTo ?? "12:00:00")),
    });
  const send = (batch: Ping[], now = batch.at(-1)?.recordedAt ?? ist("09:00:00")) =>
    ingestPings(db(), { workspaceId: ws.id, deviceId: device.id, pings: batch }, new Date(now + 2_000));
  const state = async () => (await db().select().from(vehicleState).where(eq(vehicleState.vehicleId, vehicle.id)))[0];
  return { ws, riva, circle, route, service, vehicle, device, send, state };
}

/** dwell at Riva 08:58–09:01, drive to Circle 09:01–09:04, dwell at Circle 09:04–09:05 */
const riva = track(ist("08:58:00"), ist("09:01:00"), RIVA);
const drive = track(ist("09:01:10"), ist("09:04:00"), RIVA, CIRCLE);
const atCircle = track(ist("09:04:10"), ist("09:05:00"), CIRCLE);

describe("ingestPings", () => {
  it("stores pings with the vehicle resolved from the assignment, skipping duplicates", async () => {
    const w = await world();
    const r1 = await w.send(riva);
    expect(r1.inserted).toBe(riva.length);
    expect(r1.vehicleIds).toEqual([w.vehicle.id]);
    const r2 = await w.send(riva);
    expect(r2.inserted).toBe(0);
    const rows = await db().select().from(pings).where(eq(pings.deviceId, w.device.id));
    expect(rows).toHaveLength(riva.length);
    expect(rows.every((r) => r.vehicleId === w.vehicle.id && r.workspaceId === w.ws.id)).toBe(true);
  });

  it("an unassigned phone's pings are stored without a vehicle and move no state", async () => {
    const w = await world({ assign: false });
    const r = await w.send(riva);
    expect(r).toEqual({ inserted: riva.length, closedTrips: [], vehicleIds: [] });
    const rows = await db().select().from(pings).where(eq(pings.deviceId, w.device.id));
    expect(rows.every((p) => p.vehicleId === null)).toBe(true);
    expect(await w.state()).toBeUndefined();
  });

  it("refuses a device from another workspace", async () => {
    const w = await world();
    const other = await makeWorkspace(db());
    await expect(
      ingestPings(db(), { workspaceId: other.id, deviceId: w.device.id, pings: riva }, new Date(ist("09:01:05"))),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("dwell → departure → trip → arrival across batches, with the departure matched to the timetable", async () => {
    const w = await world();
    await w.send(riva);
    let s = await w.state();
    expect(s).toMatchObject({ phase: "at_spot", spotId: w.riva.id, nextSpotId: w.circle.id, serviceId: w.service.id });
    expect(s.since.getTime()).toBe(ist("08:58:00"));

    // first half of the drive: departed Riva, trip open
    const half = drive.slice(0, 9);
    const r = await w.send(half);
    expect(r.closedTrips).toEqual([]);
    s = await w.state();
    expect(s).toMatchObject({ phase: "en_route", spotId: w.riva.id, nextSpotId: w.circle.id, offRoute: false });
    expect(s.etaS).toBeGreaterThan(0);
    expect(s.lastPingAt?.getTime()).toBe(half.at(-1)?.recordedAt);
    expect(s.alongM).toBeGreaterThan(0);

    const [rivaDwell] = await db().select().from(dwells).where(eq(dwells.spotId, w.riva.id));
    expect(rivaDwell.arrivedAt.getTime()).toBe(ist("08:58:00"));
    const departedAt = rivaDwell.departedAt?.getTime() as number;
    expect(departedAt).toBeGreaterThan(ist("09:01:00"));
    expect(rivaDwell.plannedDepartureAt?.getTime()).toBe(ist("09:00:00"));

    const [m] = await db().select().from(departureMatches).where(eq(departureMatches.serviceId, w.service.id));
    expect(m).toMatchObject({ spotId: w.riva.id, date: "2026-10-13", dwellId: rivaDwell.id, missed: false });
    expect(m.plannedAt.getTime()).toBe(ist("09:00:00"));
    expect(m.actualAt?.getTime()).toBe(departedAt);
    expect(m.delayMin).toBeCloseTo((departedAt - ist("09:00:00")) / 60000, 1);

    // rest of the drive + arrival at Circle closes the trip
    const r2 = await w.send([...drive.slice(9), ...atCircle]);
    expect(r2.closedTrips).toHaveLength(1);
    const [trip] = r2.closedTrips;
    expect(trip).toMatchObject({
      vehicleId: w.vehicle.id,
      serviceId: w.service.id,
      routeId: w.route.id,
      fromSpotId: w.riva.id,
      toSpotId: w.circle.id,
      quality: "clean",
    });
    expect(trip.departedAt.getTime()).toBe(departedAt);
    expect(trip.durationS).toBe(((trip.arrivedAt?.getTime() as number) - departedAt) / 1000);
    s = await w.state();
    expect(s).toMatchObject({ phase: "at_spot", spotId: w.circle.id, nextSpotId: w.riva.id });
  });

  it("late pings are stored but never move live state backwards", async () => {
    const w = await world();
    await w.send([...riva, ...drive, ...atCircle]);
    const before = await w.state();
    // an old fix at Riva that the phone uploads late (not a duplicate: a new timestamp)
    const r = await w.send([ping(ist("09:00:55"), RIVA)], ist("09:05:30"));
    expect(r.inserted).toBe(1);
    const after = await w.state();
    expect(after).toMatchObject({ phase: "at_spot", spotId: w.circle.id, lat: before.lat, lng: before.lng });
    expect(after.lastPingAt?.getTime()).toBe(before.lastPingAt?.getTime());
    expect(await db().select().from(dwells).where(eq(dwells.vehicleId, w.vehicle.id))).toHaveLength(2);
  });

  it("a trip with > 2 min without fixes is a gap trip", async () => {
    const w = await world();
    const holed = drive.filter((p) => p.recordedAt < ist("09:01:40") || p.recordedAt > ist("09:03:50"));
    const r = await w.send([...riva, ...holed, ...atCircle]);
    expect(r.closedTrips).toHaveLength(1);
    expect(r.closedTrips[0].quality).toBe("gap");
  });

  it("> 150 m off the path for > 1 min: vehicle flagged off route, trip quality off_route", async () => {
    const w = await world();
    // 09:02:00–09:03:10 about 300 m east of the road
    const detour = drive.map((p) =>
      p.recordedAt >= ist("09:02:00") && p.recordedAt <= ist("09:03:10") ? { ...p, lng: p.lng + 0.0028 } : p,
    );
    await w.send([...riva, ...detour.filter((p) => p.recordedAt <= ist("09:03:10"))]);
    expect(await w.state()).toMatchObject({ offRoute: true, offRouteSince: new Date(ist("09:02:00")) });
    const r = await w.send([...detour.filter((p) => p.recordedAt > ist("09:03:10")), ...atCircle]);
    expect(await w.state()).toMatchObject({ offRoute: false, offRouteSince: null });
    expect(r.closedTrips[0].quality).toBe("off_route");
  });

  it("off_route_since keeps the start of a stretch longer than the 10 min look-back", async () => {
    const w = await world();
    const east = { lat: RIVA.lat + 0.005, lng: RIVA.lng + 0.0028 };
    await w.send([...riva, ...track(ist("09:01:10"), ist("09:04:00"), RIVA, east)]);
    const since = (await w.state()).offRouteSince?.getTime() as number;
    expect(since).toBeLessThan(ist("09:03:00"));
    await w.send(track(ist("09:04:10"), ist("09:15:00"), east));
    expect(await w.state()).toMatchObject({ offRoute: true, offRouteSince: new Date(since) });
  });

  it("a short excursion off the path (< 1 min) is not off route", async () => {
    const w = await world();
    const blip = drive.map((p) =>
      p.recordedAt >= ist("09:02:00") && p.recordedAt <= ist("09:02:30") ? { ...p, lng: p.lng + 0.0028 } : p,
    );
    const r = await w.send([...riva, ...blip, ...atCircle]);
    expect(r.closedTrips[0].quality).toBe("clean");
  });

  it("planned departures that passed with no actual departure are marked missed", async () => {
    const w = await world();
    // waits at Riva until 09:41, so 09:00 has nothing within ±25 min and 09:40 is taken
    const late = [
      ...track(ist("08:58:00"), ist("09:41:00"), RIVA),
      ...track(ist("09:41:10"), ist("09:44:00"), RIVA, CIRCLE),
    ];
    await w.send(late);
    const ms = await db()
      .select()
      .from(departureMatches)
      .where(and(eq(departureMatches.serviceId, w.service.id), eq(departureMatches.spotId, w.riva.id)))
      .orderBy(departureMatches.plannedAt);
    expect(ms.map((m) => [m.plannedAt.getTime(), m.missed])).toEqual([
      [ist("09:00:00"), true],
      [ist("09:40:00"), false],
    ]);
    expect(ms[0].actualAt).toBeNull();
    expect(ms[1].delayMin).toBeGreaterThan(1);
  });

  it("a backlog whose newest fix is > 2 min old is processed but leaves the vehicle offline, not live", async () => {
    const w = await world();
    // the phone reconnects at 09:06 and uploads 08:58–09:01
    const r = await w.send(riva, ist("09:06:00"));
    expect(r.vehicleIds).toEqual([]);
    expect(await w.state()).toMatchObject({
      phase: "offline",
      serviceId: w.service.id,
      etaS: null,
      nextSpotId: null,
      alongM: null,
    });
    expect((await w.state()).lastPingAt?.getTime()).toBe(ist("09:01:00"));
    expect(await db().select().from(dwells).where(eq(dwells.vehicleId, w.vehicle.id))).toHaveLength(1);
  });

  it("back-to-back services on one vehicle: each instant belongs to the service running then", async () => {
    const w = await world();
    const [next] = await db()
      .insert(services)
      .values({
        workspaceId: w.ws.id,
        name: "Late",
        kind: "regular",
        routeId: w.route.id,
        validFrom: "2026-10-11",
        validTo: "2026-11-01",
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        startTime: "11:00",
        endTime: "13:00",
        pattern: { kind: "times", times: ["11:30"] },
      })
      .returning();
    await db()
      .insert(serviceVehicles)
      .values({
        workspaceId: w.ws.id,
        serviceId: next.id,
        vehicleId: w.vehicle.id,
        startsAt: new Date(ist("11:00:00")),
        endsAt: new Date(ist("13:00:00")),
      });
    await w.send(riva);
    expect((await w.state()).serviceId).toBe(w.service.id);
    // 11:05 is inside Regular's 15 min padding but Late's own hours
    await w.send(track(ist("11:05:00"), ist("11:06:00"), CIRCLE));
    expect((await w.state()).serviceId).toBe(next.id);
    const [d] = await db().select().from(dwells).where(eq(dwells.spotId, w.circle.id));
    expect(d.serviceId).toBe(next.id);
  });

  it("pings outside any service window keep the vehicle off duty with no service", async () => {
    const w = await world({ svFrom: "10:00:00", svTo: "11:00:00" });
    await w.send(riva);
    expect(await w.state()).toMatchObject({ phase: "off_duty", serviceId: null, spotId: w.riva.id });
  });
});

describe("refreshPhases", () => {
  it("offline after 2 min silent inside a window, off_duty outside, untouched when fresh", async () => {
    const w = await world();
    await w.send(riva);
    expect(await refreshPhases(db(), w.ws.id, new Date(ist("09:02:00")))).toEqual([]);
    expect((await w.state()).phase).toBe("at_spot");

    expect(await refreshPhases(db(), w.ws.id, new Date(ist("09:03:30")))).toEqual([w.vehicle.id]);
    expect(await w.state()).toMatchObject({ phase: "offline" });
    expect((await w.state()).since.getTime()).toBe(ist("09:03:30"));
    expect(await refreshPhases(db(), w.ws.id, new Date(ist("09:04:00")))).toEqual([]);

    expect(await refreshPhases(db(), w.ws.id, new Date(ist("13:00:00")))).toEqual([w.vehicle.id]);
    expect(await w.state()).toMatchObject({ phase: "off_duty", serviceId: null });

    // pings bring it back
    await w.send(track(ist("09:10:00"), ist("09:10:30"), RIVA), ist("09:10:30"));
    expect(await w.state()).toMatchObject({ phase: "at_spot", serviceId: w.service.id });
  });

  it("sweeps planned departures that passed with no departure at all into missed", async () => {
    const w = await world();
    // departs Riva for 09:00, then never again
    await w.send([...riva, ...drive, ...atCircle]);
    const matches = () =>
      db()
        .select()
        .from(departureMatches)
        .where(eq(departureMatches.serviceId, w.service.id))
        .orderBy(departureMatches.plannedAt);
    expect((await matches()).map((m) => m.plannedAt.getTime())).toEqual([ist("09:00:00")]);

    await refreshPhases(db(), w.ws.id, new Date(ist("10:00:00"))); // 09:40 not due until 10:05
    expect(await matches()).toHaveLength(1);

    await refreshPhases(db(), w.ws.id, new Date(ist("10:10:00")));
    expect((await matches()).map((m) => [m.plannedAt.getTime(), m.missed, m.date])).toEqual([
      [ist("09:00:00"), false, "2026-10-13"],
      [ist("09:40:00"), true, "2026-10-13"],
    ]);
  });
});

describe("vehicleStates", () => {
  it("lists only the workspace's vehicles", async () => {
    const a = await world();
    const b = await world();
    await a.send(riva);
    await b.send(riva);
    const rows = await vehicleStates(db(), a.ws.id);
    expect(rows.map((r) => r.vehicleId)).toEqual([a.vehicle.id]);
    expect(await db().select().from(trips).where(eq(trips.workspaceId, a.ws.id))).toEqual([]);
  });
});
