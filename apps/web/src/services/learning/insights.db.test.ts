import { randomUUID } from "node:crypto";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
import type { Db } from "@/db";
import {
  departureMatches,
  devices,
  dwells,
  pings,
  routes,
  serviceExceptions,
  services,
  serviceVehicles,
  spots,
  trips,
  vehicles,
} from "@/db/schema";
import { systemActor } from "../kernel";
import { getInsights } from "./insights";

const db = () => testDb();
/** IST wall clock → Date */
const ist = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`);
const D1 = "2026-10-12"; // Monday
const D2 = "2026-10-13";
const D3 = "2026-10-14";

async function seed(dbx: Db) {
  const ws = await makeWorkspace(dbx);
  const w = ws.id;
  const [a, b] = await dbx
    .insert(spots)
    .values([
      { workspaceId: w, name: "Riva", shortName: "Riva", lat: 15.6, lng: 73.7 },
      { workspaceId: w, name: "Circle", shortName: "Circle", lat: 15.62, lng: 73.72 },
    ])
    .returning();
  const [route] = await dbx
    .insert(routes)
    .values({ workspaceId: w, name: "Loop", spotIds: [a.id, b.id, a.id] })
    .returning();
  const svc = {
    workspaceId: w,
    kind: "regular" as const,
    routeId: route.id,
    validFrom: "2026-10-01",
    validTo: "2026-10-31",
  };
  const [s1, s2] = await dbx
    .insert(services)
    .values([
      {
        ...svc,
        name: "Main",
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        startTime: "09:00",
        endTime: "12:00",
        pattern: { kind: "every", everyMin: 20 },
      },
      {
        ...svc,
        name: "Extra",
        daysOfWeek: [1],
        startTime: "09:00",
        endTime: "10:00",
        pattern: { kind: "times", times: ["09:20"] },
      },
    ])
    .returning();
  const [v] = await dbx.insert(vehicles).values({ workspaceId: w, name: "Van 1" }).returning();
  const [dev] = await dbx.insert(devices).values({ workspaceId: w, label: "P1", tokenHash: randomUUID() }).returning();
  return { w, a, b, route, s1, s2, v, dev };
}

describe("getInsights", () => {
  it("on-time % per spot and the delay heatmap by IST slot × weekday", async () => {
    const { w, a, s1, s2 } = await seed(db());
    const m = (serviceId: string, date: string, hhmm: string, delayMin: number | null) => ({
      workspaceId: w,
      serviceId,
      spotId: a.id,
      date,
      plannedAt: ist(date, hhmm),
      delayMin,
      missed: delayMin === null,
    });
    await db()
      .insert(departureMatches)
      .values([
        m(s1.id, D1, "09:00", 1),
        m(s1.id, D1, "09:20", 5),
        m(s1.id, D1, "09:40", null),
        m(s2.id, D1, "09:20", 10),
        m(s1.id, D2, "09:00", -2),
        m(s1.id, "2026-10-20", "09:00", 30), // outside the range
      ]);
    const r = await getInsights(db(), systemActor("test"), { workspaceId: w, from: D1, to: D2 });
    // on time = within 3 min either way; missed counts as not on time
    expect(r.onTime).toEqual([{ spotId: a.id, pct: 40, n: 5 }]);
    expect(r.delayBySlot).toEqual([
      { spotId: a.id, slot: "09:00", weekday: 1, avgMin: 1, p80Min: 1, n: 1 },
      { spotId: a.id, slot: "09:00", weekday: 2, avgMin: -2, p80Min: -2, n: 1 },
      { spotId: a.id, slot: "09:20", weekday: 1, avgMin: 7.5, p80Min: 9, n: 2 },
    ]);
  });

  it("dwell by spot and IST hour, leg time by hour, loop cycle and average wait", async () => {
    const { w, a, b, route, s1, v } = await seed(db());
    const dw = (from: string, to: string | null) => ({
      workspaceId: w,
      vehicleId: v.id,
      spotId: a.id,
      arrivedAt: ist(D1, from),
      departedAt: to ? ist(D1, to) : null,
    });
    await db()
      .insert(dwells)
      .values([
        dw("09:05", "09:08"),
        dw("09:30", "09:35"),
        dw("09:50", "09:52"),
        dw("10:10", "10:20"),
        dw("11:00", null),
      ]);
    const t = (
      date: string,
      from: string,
      to: string,
      hhmm: string,
      durationS: number,
      quality: "clean" | "off_route" = "clean",
    ) => ({
      workspaceId: w,
      vehicleId: v.id,
      serviceId: s1.id,
      routeId: route.id,
      fromSpotId: from,
      toSpotId: to,
      departedAt: ist(date, hhmm),
      arrivedAt: new Date(ist(date, hhmm).getTime() + durationS * 1000),
      durationS,
      quality,
    });
    await db()
      .insert(trips)
      .values([
        t(D1, a.id, b.id, "09:00", 600),
        t(D1, b.id, a.id, "09:20", 700),
        t(D1, a.id, b.id, "09:50", 900),
        t(D1, a.id, b.id, "10:30", 3000, "off_route"),
        t(D2, a.id, b.id, "09:00", 800),
        { workspaceId: w, vehicleId: v.id, routeId: route.id, fromSpotId: b.id, departedAt: ist(D2, "09:15") }, // still open
      ]);
    const r = await getInsights(db(), systemActor("test"), { workspaceId: w, from: D1, to: D2 });
    expect(r.dwellBySpotHour).toEqual([
      { spotId: a.id, hour: 9, medianS: 180, n: 3 },
      { spotId: a.id, hour: 10, medianS: 600, n: 1 },
    ]);
    // off-route and open trips don't count towards leg times
    expect(r.legByHour).toEqual(
      expect.arrayContaining([
        { fromSpotId: a.id, toSpotId: b.id, hour: 9, medianS: 800, n: 3 },
        { fromSpotId: b.id, toSpotId: a.id, hour: 9, medianS: 700, n: 1 },
      ]),
    );
    expect(r.legByHour).toHaveLength(2);
    // departures from the route's first spot, same vehicle, same IST day: 09:00→09:50→10:30
    expect(r.loopCycleS).toEqual([{ routeId: route.id, medianS: 2700, n: 2 }]);
    // headways at Riva 3000, 2400 → (3000² + 2400²) / (2 · 5400); Circle has only one departure a day
    const wait = Object.fromEntries(r.averageWaitS.map((x) => [x.spotId, x.seconds]));
    expect(wait[a.id]).toBeCloseTo(14_760_000 / 10_800, 6);
    expect(wait[b.id]).toBeNull();
  });

  it("tracked % = service windows (vehicle × running IST day) that got at least one ping", async () => {
    const { w, s1, v, dev } = await seed(db());
    await db()
      .insert(serviceVehicles)
      .values({
        workspaceId: w,
        serviceId: s1.id,
        vehicleId: v.id,
        startsAt: ist(D1, "00:00"),
        endsAt: ist("2026-10-15", "00:00"),
      });
    await db().insert(serviceExceptions).values({ workspaceId: w, serviceId: s1.id, date: D3, kind: "cancel_day" });
    const p = (date: string, hhmm: string) => ({
      workspaceId: w,
      deviceId: dev.id,
      vehicleId: v.id,
      recordedAt: ist(date, hhmm),
      lat: 15.6,
      lng: 73.7,
      accuracy: 10,
    });
    // D1 tracked inside 09:00–12:00; D2 only pinged after the window; D3 cancelled (no window)
    await db()
      .insert(pings)
      .values([p(D1, "09:10"), p(D2, "13:00"), p(D3, "10:00")]);
    const r = await getInsights(db(), systemActor("test"), { workspaceId: w, from: D1, to: D3 });
    expect(r.trackedPct).toBe(50);
  });

  it("an empty workspace gives empty insights, with every spot's wait unknown", async () => {
    const { w, a, b } = await seed(db());
    const r = await getInsights(db(), systemActor("test"), { workspaceId: w, from: D1, to: D1 });
    expect(r).toMatchObject({
      onTime: [],
      delayBySlot: [],
      dwellBySpotHour: [],
      legByHour: [],
      loopCycleS: [],
      trackedPct: 0,
    });
    expect(r.averageWaitS).toEqual(
      expect.arrayContaining([
        { spotId: a.id, seconds: null },
        { spotId: b.id, seconds: null },
      ]),
    );
  });

  it("never mixes in another workspace's data", async () => {
    const one = await seed(db());
    const two = await seed(db());
    await db()
      .insert(departureMatches)
      .values({
        workspaceId: two.w,
        serviceId: two.s1.id,
        spotId: two.a.id,
        date: D1,
        plannedAt: ist(D1, "09:00"),
        delayMin: 0,
      });
    const r = await getInsights(db(), systemActor("test"), { workspaceId: one.w, from: D1, to: D1 });
    expect(r.onTime).toEqual([]);
    expect(r.averageWaitS).toHaveLength(2);
  });

  it("viewers of the workspace may read; others are refused; bad ranges are invalid", async () => {
    const { w } = await seed(db());
    const other = await makeWorkspace(db());
    const { actor: viewer } = await makeAdmin(db(), w, "viewer");
    const { actor: outsider } = await makeAdmin(db(), other.id, "admin");
    await expect(getInsights(db(), viewer, { workspaceId: w, from: D1, to: D1 })).resolves.toBeTruthy();
    await expect(getInsights(db(), outsider, { workspaceId: w, from: D1, to: D1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(getInsights(db(), viewer, { workspaceId: w, from: D2, to: D1 })).rejects.toMatchObject({
      code: "INVALID",
    });
  });
});
