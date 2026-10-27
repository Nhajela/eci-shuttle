import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
import {
  routes,
  serviceExceptions,
  services,
  serviceVehicles,
  spots,
  vehicleBreaks,
  vehicleState,
  vehicles,
} from "@/db/schema";
import { PublicMap, publicPositions } from "./positions";

const db = () => testDb();
const at = (hhmm: string, date = "2026-10-12") => new Date(`${date}T${hhmm}:00+05:30`);
const NOW = at("09:30");

async function world(
  over: { public?: boolean; validTo?: string; startTime?: string; endTime?: string; daysOfWeek?: number[] } = {},
) {
  const w = await makeWorkspace(db());
  const [riva, circle] = await db()
    .insert(spots)
    .values([
      { workspaceId: w.id, name: "Riva Beach Resort", shortName: "Riva", lat: 15.6553, lng: 73.7152 },
      { workspaceId: w.id, name: "The Circle", shortName: "Circle", lat: 15.664, lng: 73.7185 },
    ])
    .returning();
  const [route] = await db()
    .insert(routes)
    .values({
      workspaceId: w.id,
      name: "Riva ⇄ Circle",
      spotIds: [riva.id, circle.id, riva.id],
      path: [
        { lat: 15.6553, lng: 73.7152 },
        { lat: 15.66, lng: 73.717 },
        { lat: 15.664, lng: 73.7185 },
        { lat: 15.66, lng: 73.717 },
        { lat: 15.6553, lng: 73.7152 },
      ],
      spotPathIdx: [0, 2, 4],
    })
    .returning();
  const [svc] = await db()
    .insert(services)
    .values({
      workspaceId: w.id,
      name: "Riva ⇄ Circle",
      kind: "regular",
      routeId: route.id,
      public: over.public ?? true,
      validFrom: "2026-10-01",
      validTo: over.validTo ?? "2026-11-01",
      daysOfWeek: over.daysOfWeek ?? [1, 2, 3, 4, 5, 6, 7],
      startTime: over.startTime ?? "08:00",
      endTime: over.endTime ?? "22:00",
      pattern: { kind: "loop" },
    })
    .returning();
  return { w, riva, circle, route, svc };
}

type StateOver = Partial<typeof vehicleState.$inferInsert> & { phase: "at_spot" | "en_route" | "offline" | "off_duty" };

/** A vehicle with a shift on `serviceId` 08:00–12:00 (unless `shift` says otherwise) and a 30 s old fix. */
async function bus(
  ws: string,
  serviceId: string,
  name: string,
  state: StateOver,
  opts: { shift?: [Date, Date] | null; active?: boolean; colour?: string } = {},
) {
  const [v] = await db()
    .insert(vehicles)
    .values({ workspaceId: ws, name, active: opts.active ?? true, colour: opts.colour ?? null })
    .returning();
  if (opts.shift !== null) {
    const [s, e] = opts.shift ?? [at("08:00"), at("12:00")];
    await db().insert(serviceVehicles).values({ workspaceId: ws, serviceId, vehicleId: v.id, startsAt: s, endsAt: e });
  }
  await db()
    .insert(vehicleState)
    .values({
      vehicleId: v.id,
      workspaceId: ws,
      serviceId,
      lat: 15.66,
      lng: 73.717,
      lastPingAt: new Date(NOW.getTime() - 30_000),
      ...state,
    });
  return v;
}

const names = async (ws: string) => (await publicPositions(db(), ws, NOW)).vehicles.map((v) => v.name);

describe("publicPositions: what attendees may see", () => {
  it("shows a vehicle on an active shift of a public service with a fresh fix, with its leg and heading", async () => {
    const { w, riva, circle, route, svc } = await world();
    const v = await bus(
      w.id,
      svc.id,
      "Shuttle 1",
      { phase: "en_route", spotId: riva.id, nextSpotId: circle.id, alongM: 300 },
      { colour: "#286c71" },
    );
    const m = PublicMap.parse(await publicPositions(db(), w.id, NOW));
    expect(m.generatedAt).toBe(NOW.toISOString());
    expect(m.spots).toEqual([
      { id: riva.id, name: "Riva Beach Resort", shortName: "Riva", lat: 15.6553, lng: 73.7152 },
      { id: circle.id, name: "The Circle", shortName: "Circle", lat: 15.664, lng: 73.7185 },
    ]);
    expect(m.routes).toHaveLength(1);
    expect(m.routes[0]).toMatchObject({ id: route.id, spotIds: route.spotIds, path: route.path });
    expect(m.routes[0]?.lengthM).toBeGreaterThan(1000);
    expect(m.vehicles).toEqual([
      {
        id: v.id,
        name: "Shuttle 1",
        colour: "#286c71",
        lat: 15.66,
        lng: 73.717,
        phase: "en_route",
        onBreak: false,
        routeId: route.id,
        atSpotId: null,
        nextSpotId: circle.id,
        nextSpotName: "Circle",
        legIndex: 0,
        legFraction: expect.any(Number),
        headingDeg: expect.any(Number),
        alongM: 300,
        since: expect.any(String),
        lastSeenS: 30,
      },
    ]);
    const only = m.vehicles[0];
    expect(only?.legFraction).toBeGreaterThan(0);
    expect(only?.legFraction).toBeLessThan(1);
    // leg 0 heads north-north-east from Riva to Circle
    expect(only?.headingDeg).toBeGreaterThan(0);
    expect(only?.headingDeg).toBeLessThan(60);
  });

  it("a vehicle at a stop says which one, and heads nowhere", async () => {
    const { w, riva, circle, svc } = await world();
    await bus(w.id, svc.id, "Shuttle 1", { phase: "at_spot", spotId: riva.id, nextSpotId: circle.id, alongM: 0 });
    const [v] = (await publicPositions(db(), w.id, NOW)).vehicles;
    expect(v).toMatchObject({ phase: "at_spot", atSpotId: riva.id, nextSpotId: circle.id, nextSpotName: "Circle" });
    expect(v?.headingDeg).toBeNull();
    expect(v?.alongM).toBe(0);
  });

  it("an off-route vehicle has no place along the road (the map draws it where it is)", async () => {
    const { w, circle, svc } = await world();
    await bus(w.id, svc.id, "Detour", { phase: "en_route", nextSpotId: circle.id, alongM: 300, offRoute: true });
    const [v] = (await publicPositions(db(), w.id, NOW)).vehicles;
    expect(v?.alongM).toBeNull();
  });

  it("never shows a vehicle outside its shift: a driver going home is nobody's business", async () => {
    const { w, riva, circle, svc } = await world();
    // shift over at 09:00, still pinging with a position
    await bus(
      w.id,
      svc.id,
      "Went home",
      { phase: "en_route", spotId: riva.id, nextSpotId: circle.id, alongM: 300 },
      { shift: [at("06:00"), at("09:00")] },
    );
    // shift not started yet
    await bus(
      w.id,
      svc.id,
      "Not yet",
      { phase: "en_route", spotId: riva.id, nextSpotId: circle.id, alongM: 300 },
      { shift: [at("10:00"), at("14:00")] },
    );
    // no shift at all
    await bus(w.id, svc.id, "Unassigned", { phase: "en_route", nextSpotId: circle.id, alongM: 300 }, { shift: null });
    // on shift but off duty / offline with a stored position
    await bus(w.id, svc.id, "Off duty", { phase: "off_duty", serviceId: null });
    await bus(w.id, svc.id, "Offline", { phase: "offline" });
    // on shift, but ingest resolved it to another service (a party run)
    await bus(w.id, svc.id, "Elsewhere", { phase: "en_route", serviceId: null, nextSpotId: circle.id, alongM: 300 });
    // retired vehicle
    await bus(w.id, svc.id, "Retired", { phase: "en_route", nextSpotId: circle.id, alongM: 300 }, { active: false });
    const m = await publicPositions(db(), w.id, NOW);
    expect(m.vehicles).toEqual([]);
    expect(JSON.stringify(m)).not.toMatch(/Went home|Not yet|Unassigned|Off duty|Offline|Elsewhere|Retired/);
  });

  it("hides a vehicle whose last fix is over 5 minutes old", async () => {
    const { w, circle, svc } = await world();
    await bus(w.id, svc.id, "Fresh", {
      phase: "en_route",
      nextSpotId: circle.id,
      alongM: 300,
      lastPingAt: new Date(NOW.getTime() - 299_000),
    });
    await bus(w.id, svc.id, "Stale", {
      phase: "en_route",
      nextSpotId: circle.id,
      alongM: 300,
      lastPingAt: new Date(NOW.getTime() - 301_000),
    });
    await bus(w.id, svc.id, "Never", { phase: "en_route", nextSpotId: circle.id, lastPingAt: null, lat: null });
    expect(await names(w.id)).toEqual(["Fresh"]);
  });

  describe("an offline vehicle follows the same 5 minute rule as the text (sight.ts)", () => {
    const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

    it("ingest marks it offline after 2 min: still shown at 3 min, rebuilt as en route on its leg", async () => {
      const { w, riva, circle, svc } = await world();
      await bus(w.id, svc.id, "Quiet", {
        phase: "offline",
        spotId: riva.id,
        nextSpotId: circle.id,
        alongM: 300,
        lastPingAt: ago(180),
        geofence: { insideSpotId: null, enteredAt: null, candidateSpotId: null, candidateSince: null, lastFixAt: null },
      });
      const [v] = PublicMap.parse(await publicPositions(db(), w.id, NOW)).vehicles;
      expect(v).toMatchObject({
        name: "Quiet",
        phase: "en_route",
        atSpotId: null,
        nextSpotId: circle.id,
        legIndex: 0,
        lastSeenS: 180,
      });
      expect(v?.legFraction).toBeGreaterThan(0);
      expect(v?.headingDeg).not.toBeNull();
    });

    it("offline inside a stop is rebuilt as waiting at that stop, with its arrival as `since`", async () => {
      const { w, riva, circle, svc } = await world();
      const arrived = ago(400).getTime();
      await bus(w.id, svc.id, "Waiting", {
        phase: "offline",
        spotId: null,
        nextSpotId: circle.id,
        alongM: 0,
        lastPingAt: ago(200),
        since: ago(120),
        geofence: {
          insideSpotId: riva.id,
          enteredAt: arrived,
          candidateSpotId: null,
          candidateSince: null,
          lastFixAt: null,
        },
      });
      const [v] = (await publicPositions(db(), w.id, NOW)).vehicles;
      expect(v).toMatchObject({ phase: "at_spot", atSpotId: riva.id, legIndex: null, headingDeg: null });
      expect(v?.since).toBe(new Date(arrived).toISOString());
    });

    it("is gone at 6 min, and a vehicle parked at a stop 5-15 min ago is not drawn either", async () => {
      const { w, riva, circle, svc } = await world();
      await bus(w.id, svc.id, "Gone", {
        phase: "offline",
        spotId: riva.id,
        nextSpotId: circle.id,
        alongM: 300,
        lastPingAt: ago(360),
      });
      await bus(w.id, svc.id, "Parked", {
        phase: "offline",
        nextSpotId: circle.id,
        alongM: 0,
        lastPingAt: ago(480),
        geofence: {
          insideSpotId: riva.id,
          enteredAt: ago(900).getTime(),
          candidateSpotId: null,
          candidateSince: null,
          lastFixAt: null,
        },
      });
      expect(await names(w.id)).toEqual([]);
    });

    it("offline with nothing to rebuild from stays hidden", async () => {
      const { w, svc } = await world();
      await bus(w.id, svc.id, "Blank", { phase: "offline", lastPingAt: ago(180) });
      expect(await names(w.id)).toEqual([]);
    });
  });

  it("flags a vehicle on a driver's break, and still shows where it is", async () => {
    const { w, riva, svc } = await world();
    const v = await bus(w.id, svc.id, "Chai", { phase: "at_spot", spotId: riva.id, alongM: 0 });
    await db()
      .insert(vehicleBreaks)
      .values({ workspaceId: w.id, vehicleId: v.id, startsAt: at("09:00"), endsAt: null });
    const m = await publicPositions(db(), w.id, NOW);
    expect(m.vehicles).toEqual([expect.objectContaining({ name: "Chai", onBreak: true, atSpotId: riva.id })]);
  });

  it("ignores private services and services not valid today", async () => {
    const priv = await world({ public: false });
    await bus(priv.w.id, priv.svc.id, "Staff car", { phase: "en_route", nextSpotId: priv.circle.id, alongM: 300 });
    const m1 = await publicPositions(db(), priv.w.id, NOW);
    expect(m1).toMatchObject({ spots: [], routes: [], vehicles: [] });

    const old = await world({ validTo: "2026-10-05" });
    await bus(old.w.id, old.svc.id, "Last week", { phase: "en_route", nextSpotId: old.circle.id, alongM: 300 });
    const m2 = await publicPositions(db(), old.w.id, NOW);
    expect(m2).toMatchObject({ spots: [], routes: [], vehicles: [] });
  });

  describe("service days (same rule as the text)", () => {
    const onShift: [Date, Date] = [at("22:00", "2026-10-12"), at("04:00", "2026-10-13")];

    it("a cross-midnight service from yesterday still shows its shuttle after midnight", async () => {
      // Monday only, 20:00-02:00; it is 00:30 on Tuesday
      const { w, circle, svc } = await world({ startTime: "20:00", endTime: "02:00", daysOfWeek: [1] });
      const now = at("00:30", "2026-10-13");
      await bus(
        w.id,
        svc.id,
        "Night owl",
        { phase: "en_route", nextSpotId: circle.id, alongM: 300, lastPingAt: new Date(now.getTime() - 30_000) },
        { shift: onShift },
      );
      const m = await publicPositions(db(), w.id, now);
      expect(m.vehicles.map((v) => v.name)).toEqual(["Night owl"]);
      expect(m.routes).toHaveLength(1);
    });

    it("but not once yesterday's window has ended", async () => {
      const { w, circle, svc } = await world({ startTime: "20:00", endTime: "02:00", daysOfWeek: [1] });
      const now = at("02:30", "2026-10-13");
      await bus(
        w.id,
        svc.id,
        "Late",
        { phase: "en_route", nextSpotId: circle.id, alongM: 300, lastPingAt: new Date(now.getTime() - 30_000) },
        { shift: onShift },
      );
      expect(await publicPositions(db(), w.id, now)).toMatchObject({ spots: [], routes: [], vehicles: [] });
    });

    it("a cancelled day (cancel_day) shows nothing, even with a shuttle on shift", async () => {
      const { w, circle, svc } = await world();
      await bus(w.id, svc.id, "Cancelled", { phase: "en_route", nextSpotId: circle.id, alongM: 300 });
      await db()
        .insert(serviceExceptions)
        .values({ workspaceId: w.id, serviceId: svc.id, date: "2026-10-12", kind: "cancel_day" });
      expect(await publicPositions(db(), w.id, NOW)).toMatchObject({ spots: [], routes: [], vehicles: [] });
    });

    it("cancelling yesterday does not hide today's run, and cancelling today leaves yesterday's tail", async () => {
      const { w, circle, svc } = await world({ startTime: "20:00", endTime: "02:00" });
      const now = at("00:30", "2026-10-13");
      await bus(
        w.id,
        svc.id,
        "Tail",
        { phase: "en_route", nextSpotId: circle.id, alongM: 300, lastPingAt: new Date(now.getTime() - 30_000) },
        { shift: onShift },
      );
      await db()
        .insert(serviceExceptions)
        .values({ workspaceId: w.id, serviceId: svc.id, date: "2026-10-13", kind: "cancel_day" });
      expect((await publicPositions(db(), w.id, now)).vehicles.map((v) => v.name)).toEqual(["Tail"]);
      await db()
        .insert(serviceExceptions)
        .values({ workspaceId: w.id, serviceId: svc.id, date: "2026-10-12", kind: "cancel_day" });
      expect((await publicPositions(db(), w.id, now)).vehicles).toEqual([]);
    });
  });

  it("keeps workspaces apart", async () => {
    const a = await world();
    const b = await world();
    await bus(a.w.id, a.svc.id, "A1", { phase: "en_route", nextSpotId: a.circle.id, alongM: 300 });
    await bus(b.w.id, b.svc.id, "B1", { phase: "en_route", nextSpotId: b.circle.id, alongM: 300 });
    expect(await names(a.w.id)).toEqual(["A1"]);
    expect(await names(b.w.id)).toEqual(["B1"]);
    const ma = await publicPositions(db(), a.w.id, NOW);
    expect(ma.spots.map((s) => s.id).sort()).toEqual([a.riva.id, a.circle.id].sort());
    expect(ma.routes.map((r) => r.id)).toEqual([a.route.id]);
  });

  it("throws NOT_FOUND for an unknown workspace", async () => {
    await expect(publicPositions(db(), "00000000-0000-4000-8000-000000000000", NOW)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
