import { randomUUID } from "node:crypto";
import type { ServicePattern } from "@eci-shuttle/shared";
import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  auditLog,
  departureMatches,
  devices,
  dwells,
  learningExclusions,
  legStats,
  pings,
  routes,
  segmentSpeeds,
  services,
  serviceVehicles,
  spots,
  suggestions,
  trips,
  vehicles,
} from "@/db/schema";
import { loadEstimates, onTripClosed, recomputeAll } from "./learning";

const db = () => testDb();
/** IST wall clock → Date */
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);
const NOW = ist("2026-10-20", "02:30");
const DAYS = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"];
const RIVA = { lat: 15.6, lng: 73.7 };
const CIRCLE = { lat: 15.609, lng: 73.7 }; // ~1 km north

async function world(pattern: ServicePattern = { kind: "times", times: ["09:40", "10:40"] }) {
  const ws = await makeWorkspace(db());
  const [riva, circle] = await db()
    .insert(spots)
    .values([
      { workspaceId: ws.id, name: "Riva", shortName: "Riva", ...RIVA },
      { workspaceId: ws.id, name: "Circle", shortName: "Circle", ...CIRCLE },
    ])
    .returning();
  const [route] = await db()
    .insert(routes)
    .values({
      workspaceId: ws.id,
      name: "Loop",
      spotIds: [riva.id, circle.id, riva.id],
      path: [RIVA, CIRCLE, RIVA],
      spotPathIdx: [0, 1, 2],
    })
    .returning();
  const svc = (kind: "regular" | "special", p: ServicePattern) => ({
    workspaceId: ws.id,
    name: kind,
    kind,
    routeId: route.id,
    validFrom: "2026-10-11",
    validTo: "2026-11-01",
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    startTime: "08:00",
    endTime: "20:00",
    pattern: p,
  });
  const [regular, special] = await db()
    .insert(services)
    .values([svc("regular", pattern), svc("special", { kind: "times", times: ["23:00"] })])
    .returning();
  const [bus] = await db().insert(vehicles).values({ workspaceId: ws.id, name: "Bus 1" }).returning();
  const [phone] = await db()
    .insert(devices)
    .values({ workspaceId: ws.id, label: "Phone", tokenHash: randomUUID() })
    .returning();
  return { ws, riva, circle, route, regular, special, bus, phone };
}
type World = Awaited<ReturnType<typeof world>>;

async function trip(
  w: World,
  o: {
    from?: string;
    to?: string;
    at: Date;
    durationS: number;
    quality?: "clean" | "off_route" | "gap";
    serviceId?: string;
  },
) {
  const [t] = await db()
    .insert(trips)
    .values({
      workspaceId: w.ws.id,
      vehicleId: w.bus.id,
      serviceId: o.serviceId ?? w.regular.id,
      routeId: w.route.id,
      fromSpotId: o.from ?? w.riva.id,
      toSpotId: o.to ?? w.circle.id,
      departedAt: o.at,
      arrivedAt: new Date(o.at.getTime() + o.durationS * 1000),
      durationS: o.durationS,
      quality: o.quality ?? "clean",
    })
    .returning();
  return t;
}

async function dwell(w: World, spotId: string, at: Date, seconds: number) {
  await db()
    .insert(dwells)
    .values({
      workspaceId: w.ws.id,
      vehicleId: w.bus.id,
      spotId,
      serviceId: w.regular.id,
      arrivedAt: at,
      departedAt: new Date(at.getTime() + seconds * 1000),
    });
}

/** six clean Riva → Circle trips at 09:40, one off-route, one > 3× median, one too old */
async function sixMorningTrips(w: World) {
  const d = [580, 600, 620, 600, 610, 590];
  for (const [i, day] of DAYS.entries()) await trip(w, { at: ist(day, "09:40"), durationS: d[i] as number });
  await trip(w, { at: ist(DAYS[4] as string, "11:00"), durationS: 3000, quality: "off_route" });
  await trip(w, { at: ist(DAYS[3] as string, "12:00"), durationS: 5000 });
  await trip(w, { at: ist("2026-09-25", "09:40"), durationS: 100 });
}

const statsOf = (w: World) => db().select().from(legStats).where(eq(legStats.workspaceId, w.ws.id));
const suggestionsOf = (w: World) => db().select().from(suggestions).where(eq(suggestions.workspaceId, w.ws.id));

describe("recomputeAll: leg_stats", () => {
  it("learns each leg from clean trips of the last 7 days, all day and per IST hour, dropping > 3× median", async () => {
    const w = await world();
    await sixMorningTrips(w);
    await recomputeAll(db(), w.ws.id, NOW);

    const rows = (await statsOf(w)).filter((r) => r.kind === "leg");
    const day = rows.find((r) => r.hourBucket === null && r.serviceId === null);
    expect(day).toMatchObject({ fromSpotId: w.riva.id, toSpotId: w.circle.id, n: 6, level: "leg_day" });
    expect(day?.medianS).toBeGreaterThanOrEqual(590);
    expect(day?.medianS).toBeLessThanOrEqual(610);
    expect(day?.p20S).toBeLessThanOrEqual(day?.medianS as number);
    expect(day?.p80S).toBeGreaterThanOrEqual(day?.medianS as number);
    expect(rows.find((r) => r.hourBucket === 9)).toMatchObject({ n: 6, level: "leg_hour" });
  });

  it("skips excluded days (all services, or just the trip's service)", async () => {
    const w = await world();
    await sixMorningTrips(w);
    await db()
      .insert(learningExclusions)
      .values([
        { workspaceId: w.ws.id, date: "2026-10-19", serviceId: null, reason: "road closed" },
        { workspaceId: w.ws.id, date: "2026-10-18", serviceId: w.regular.id },
        { workspaceId: w.ws.id, date: "2026-10-17", serviceId: w.special.id },
      ]);
    await recomputeAll(db(), w.ws.id, NOW);
    const day = (await statsOf(w)).find((r) => r.kind === "leg" && r.hourBucket === null);
    expect(day?.n).toBe(4);
  });

  it("special services learn on their own legs", async () => {
    const w = await world();
    await sixMorningTrips(w);
    for (const day of DAYS.slice(0, 3))
      await trip(w, { at: ist(day, "23:00"), durationS: 900, serviceId: w.special.id });
    await recomputeAll(db(), w.ws.id, NOW);
    const rows = await statsOf(w);
    expect(rows.find((r) => r.serviceId === w.special.id && r.hourBucket === null)).toMatchObject({
      n: 3,
      medianS: 900,
    });
    expect(rows.find((r) => r.serviceId === null && r.hourBucket === null && r.kind === "leg")?.n).toBe(6);
  });

  it("learns dwells per spot and refreshes routes.typical_leg_s; recomputing replaces rows", async () => {
    const w = await world();
    await sixMorningTrips(w);
    for (const day of DAYS) await dwell(w, w.circle.id, ist(day, "09:50"), 120);
    await recomputeAll(db(), w.ws.id, NOW);
    await recomputeAll(db(), w.ws.id, NOW);
    const rows = await statsOf(w);
    expect(rows.filter((r) => r.kind === "dwell" && r.hourBucket === null)).toEqual([
      expect.objectContaining({ fromSpotId: w.circle.id, toSpotId: null, n: 6, medianS: 120 }),
    ]);
    // checked in SQL: the driver reads a NULL int[] element back as NaN
    const [r] = await db().execute<{ first: number; unknown: boolean }>(
      sql`SELECT typical_leg_s[1] AS first, typical_leg_s[2] IS NULL AS unknown FROM routes WHERE id = ${w.route.id}`,
    );
    expect(r?.first).toBeGreaterThanOrEqual(590);
    expect(r?.unknown).toBe(true);
  });
});

describe("recomputeAll: segment_speeds", () => {
  it("derives ~200 m segment speeds from the pings of clean trips", async () => {
    const w = await world();
    const at = ist("2026-10-19", "09:40");
    // 1 km in 100 s: a fix every 20 s, ~200 m apart → ~10 m/s
    await db()
      .insert(pings)
      .values(
        Array.from({ length: 6 }, (_, i) => ({
          workspaceId: w.ws.id,
          deviceId: w.phone.id,
          vehicleId: w.bus.id,
          recordedAt: new Date(at.getTime() + i * 20_000),
          lat: RIVA.lat + (i * (CIRCLE.lat - RIVA.lat)) / 5,
          lng: RIVA.lng,
          accuracy: 5,
        })),
      );
    await trip(w, { at, durationS: 100 });
    await recomputeAll(db(), w.ws.id, NOW);
    const rows = await db()
      .select()
      .from(segmentSpeeds)
      .where(and(eq(segmentSpeeds.routeId, w.route.id)))
      .orderBy(segmentSpeeds.segmentIndex);
    const allDay = rows.filter((r) => r.hourBucket === null);
    expect(allDay.map((r) => r.segmentIndex)).toEqual([0, 1, 2, 3, 4]);
    for (const r of allDay) expect(r.medianMps).toBeCloseTo(10, 0);
    expect(allDay[0]).toMatchObject({ startM: 0, endM: 200 });
    expect(rows.some((r) => r.hourBucket === 9)).toBe(true);
  });

  it("drops trips over 3× the leg median (a breakdown's stationary pings don't drag segments down)", async () => {
    const w = await world();
    const pingsFor = (at: Date, n: number, stepS: number, lat: (i: number) => number) =>
      db()
        .insert(pings)
        .values(
          Array.from({ length: n }, (_, i) => ({
            workspaceId: w.ws.id,
            deviceId: w.phone.id,
            vehicleId: w.bus.id,
            recordedAt: new Date(at.getTime() + i * stepS * 1000),
            lat: lat(i),
            lng: RIVA.lng,
            accuracy: 5,
          })),
        );
    const dLat = CIRCLE.lat - RIVA.lat;
    // three normal 1 km / 100 s trips → ~10 m/s
    for (const day of DAYS.slice(0, 3)) {
      const at = ist(day, "09:40");
      await pingsFor(at, 6, 20, (i) => RIVA.lat + (i * dLat) / 5);
      await trip(w, { at, durationS: 100 });
    }
    const speedsOf = () =>
      db()
        .select()
        .from(segmentSpeeds)
        .where(and(eq(segmentSpeeds.routeId, w.route.id), isNull(segmentSpeeds.hourBucket)))
        .orderBy(segmentSpeeds.segmentIndex);
    await recomputeAll(db(), w.ws.id, NOW);
    const before = await speedsOf();

    // a clean 5000 s trip that sat broken down near the start: pings every 20 s barely moving
    const at = ist(DAYS[3] as string, "12:00");
    await pingsFor(at, 250, 20, (i) => RIVA.lat + (i < 249 ? 0.0001 : dLat));
    await trip(w, { at, durationS: 5000 });
    await recomputeAll(db(), w.ws.id, NOW);
    const after = await speedsOf();
    expect(after.map((r) => [r.segmentIndex, r.n, r.medianMps])).toEqual(
      before.map((r) => [r.segmentIndex, r.n, r.medianMps]),
    );
  });
});

describe("loadEstimates", () => {
  it("gives one EtaLeg per route leg (learned or baseline), dwells per spot, segments and the loop cycle", async () => {
    const w = await world();
    await sixMorningTrips(w);
    await recomputeAll(db(), w.ws.id, NOW);
    const r = await loadEstimates(
      db(),
      { workspaceId: w.ws.id, routeId: w.route.id, serviceId: w.regular.id },
      ist("2026-10-20", "09:45"),
    );
    expect(r.legs).toHaveLength(2);
    expect(r.legs[0]).toMatchObject({ fromSpotId: w.riva.id, toSpotId: w.circle.id });
    expect(r.legs[0]?.lengthM).toBeCloseTo(1000, -1);
    expect(r.legs[0]?.estimate).toMatchObject({ level: "leg_hour", n: 6, thin: false });
    expect(r.legs[1]?.estimate).toMatchObject({ level: "baseline", n: 0, thin: true });
    expect(r.legs[1]?.estimate.medianS).toBeCloseTo((r.legs[1]?.lengthM as number) / (25 / 3.6), 0);
    expect(Object.keys(r.dwells).sort()).toEqual([w.riva.id, w.circle.id].sort());
    expect(r.dwells[w.riva.id]).toMatchObject({ level: "baseline", medianS: 180 });
    const legs = r.legs.reduce((s, l) => s + l.estimate.medianS, 0);
    expect(r.cycleS).toBeCloseTo(legs + 360, 0);
  });

  it("special services read their own stats", async () => {
    const w = await world();
    await sixMorningTrips(w);
    for (const day of DAYS.slice(0, 3))
      await trip(w, { at: ist(day, "23:00"), durationS: 900, serviceId: w.special.id });
    await recomputeAll(db(), w.ws.id, NOW);
    const r = await loadEstimates(db(), { workspaceId: w.ws.id, routeId: w.route.id, serviceId: w.special.id }, NOW);
    expect(r.legs[0]?.estimate).toMatchObject({ medianS: 900, n: 3, level: "leg_day", thin: true });
  });
});

describe("onTripClosed", () => {
  it("refreshes only that leg's stats; ignores trips that aren't clean", async () => {
    const w = await world();
    await sixMorningTrips(w);
    const back = await trip(w, { from: w.circle.id, to: w.riva.id, at: ist("2026-10-19", "10:00"), durationS: 700 });
    await onTripClosed(db(), back, NOW);
    const rows = await statsOf(w);
    expect(rows.every((r) => r.fromSpotId === w.circle.id)).toBe(true);
    expect(rows.find((r) => r.kind === "leg" && r.hourBucket === null)).toMatchObject({ toSpotId: w.riva.id, n: 1 });

    const bad = await trip(w, { at: ist("2026-10-19", "12:00"), durationS: 700, quality: "gap" });
    await onTripClosed(db(), bad, NOW);
    expect((await statsOf(w)).filter((r) => r.fromSpotId === w.riva.id)).toHaveLength(0);
  });
});

describe("recomputeAll: suggestions", () => {
  async function lateNineForty(w: World) {
    const delays = [6, 8, 8, 9, 7, 10];
    for (const [i, day] of DAYS.entries()) {
      const plannedAt = ist(day, "09:40");
      await db()
        .insert(departureMatches)
        .values({
          workspaceId: w.ws.id,
          serviceId: w.regular.id,
          spotId: w.riva.id,
          date: day,
          plannedAt,
          actualAt: new Date(plannedAt.getTime() + (delays[i] as number) * 60_000),
          delayMin: delays[i],
        });
    }
  }

  it("suggests shifting a departure that leaves late, with evidence and a service.update proposal", async () => {
    const w = await world();
    await lateNineForty(w);
    const { suggestions: n } = await recomputeAll(db(), w.ws.id, NOW);
    expect(n).toBe(1);
    const [s] = await suggestionsOf(w);
    expect(s).toMatchObject({
      kind: "shift_departure",
      status: "open",
      dedupeKey: `shift:${w.regular.id}:${w.riva.id}:09:40`,
    });
    expect(s.summary).toContain("09:40");
    expect(s.summary).toContain("09:50");
    expect(s.evidence).toMatchObject({ n: 6, avgDelayMin: 8, p80DelayMin: 9, shiftMin: 10, planned: "09:40" });
    expect(s.proposedChanges).toEqual([
      {
        kind: "service.update",
        serviceId: w.regular.id,
        version: w.regular.version,
        pattern: { kind: "times", times: ["09:50", "10:40"] },
      },
    ]);
    const audit = await db().select().from(auditLog).where(eq(auditLog.entityId, s.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: "system", action: "suggestion.create", entity: "suggestion" });
  });

  it("upserts by dedupe key, never touches decided ones, and drops open ones that no longer apply", async () => {
    const w = await world();
    await lateNineForty(w);
    await recomputeAll(db(), w.ws.id, NOW);
    await recomputeAll(db(), w.ws.id, NOW);
    expect(await suggestionsOf(w)).toHaveLength(1);
    // unchanged evidence (jsonb reorders keys) is not rewritten
    const audit = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, w.ws.id), eq(auditLog.entity, "suggestion")));
    expect(audit).toHaveLength(1);

    await db().update(suggestions).set({ status: "dismissed" }).where(eq(suggestions.workspaceId, w.ws.id));
    await db().delete(departureMatches).where(eq(departureMatches.workspaceId, w.ws.id));
    await recomputeAll(db(), w.ws.id, NOW);
    expect(await suggestionsOf(w)).toEqual([expect.objectContaining({ status: "dismissed" })]);

    const w2 = await world();
    await lateNineForty(w2);
    await recomputeAll(db(), w2.ws.id, NOW);
    await db().delete(departureMatches).where(eq(departureMatches.workspaceId, w2.ws.id));
    await recomputeAll(db(), w2.ws.id, NOW);
    expect(await suggestionsOf(w2)).toHaveLength(0);
  });

  it("ignores late departures on excluded days", async () => {
    const w = await world();
    await lateNineForty(w);
    for (const date of DAYS.slice(0, 2)) await db().insert(learningExclusions).values({ workspaceId: w.ws.id, date });
    expect((await recomputeAll(db(), w.ws.id, NOW)).suggestions).toBe(0);
  });

  it("flags a frequency one vehicle can't keep up with", async () => {
    const w = await world({ kind: "every", everyMin: 40 });
    await db()
      .insert(serviceVehicles)
      .values({
        workspaceId: w.ws.id,
        serviceId: w.regular.id,
        vehicleId: w.bus.id,
        startsAt: ist("2026-10-14", "08:00"),
        endsAt: ist("2026-10-31", "20:00"),
      });
    for (const day of DAYS) {
      await trip(w, { at: ist(day, "09:00"), durationS: 1500 });
      await trip(w, { from: w.circle.id, to: w.riva.id, at: ist(day, "10:00"), durationS: 1500 });
      await dwell(w, w.riva.id, ist(day, "08:00"), 60);
      await dwell(w, w.circle.id, ist(day, "09:30"), 60);
    }
    await recomputeAll(db(), w.ws.id, NOW);
    const s = (await suggestionsOf(w)).find((x) => x.kind === "change_frequency");
    expect(s).toMatchObject({ dedupeKey: `frequency:${w.regular.id}` });
    expect(s?.evidence).toMatchObject({ cycleMin: 52, vehicles: 1, everyMin: 40, suggestedEveryMin: 55 });
    expect(s?.proposedChanges).toEqual([
      { kind: "service.update", serviceId: w.regular.id, version: 1, pattern: { kind: "every", everyMin: 55 } },
    ]);
  });

  it("flags a dwell far longer than the planned 3 min", async () => {
    const w = await world();
    for (const day of DAYS) await dwell(w, w.circle.id, ist(day, "09:50"), 540);
    await recomputeAll(db(), w.ws.id, NOW);
    const s = (await suggestionsOf(w)).find((x) => x.kind === "dwell_mismatch");
    expect(s?.summary).toContain("Circle");
    expect(s?.summary).toContain("9 min");
    expect(s?.evidence).toMatchObject({ spotId: w.circle.id, medianMin: 9, plannedMin: 3, n: 6 });
    expect(s?.proposedChanges).toEqual([]);
  });
});
