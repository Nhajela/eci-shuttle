import { randomUUID } from "node:crypto";
import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, devices, pings, routes, spots, trips, vehicles } from "@/db/schema";
import { loadDeadZones } from "./dead-zones";
import { recomputeDeadZones } from "./recompute";

const db = () => testDb();
const NOW = new Date("2026-10-28T21:00:00Z"); // 02:30 IST on the 29th
const DAYS = ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"];
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
const lat = (km: number) => 15.6 + (km / 111.2) * 1;

/** Riva —2 km— Circle —2 km— Namaka (all on one street), loop back: legs 0 Riva→Circle, 1 Circle→Namaka, 2 Namaka→Circle, 3 Circle→Riva */
async function world() {
  const ws = await makeWorkspace(db());
  const s = await db()
    .insert(spots)
    .values(
      [
        ["Riva", 0],
        ["Circle", 2],
        ["Namaka", 4],
      ].map(([n, km]) => ({
        workspaceId: ws.id,
        name: n as string,
        shortName: n as string,
        lat: lat(km as number),
        lng: 73.7,
      })),
    )
    .returning();
  const [riva, circle, namaka] = s as [(typeof s)[0], (typeof s)[0], (typeof s)[0]];
  const pt = (km: number) => ({ lat: lat(km), lng: 73.7 });
  const [route] = await db()
    .insert(routes)
    .values({
      workspaceId: ws.id,
      name: "Long",
      spotIds: [riva.id, circle.id, namaka.id, circle.id, riva.id],
      path: [pt(0), pt(2), pt(4), pt(2), pt(0)],
      spotPathIdx: [0, 1, 2, 3, 4],
    })
    .returning();
  const [bus] = await db().insert(vehicles).values({ workspaceId: ws.id, name: "Bus" }).returning();
  const mk = async (appVersion: string | null) =>
    (
      await db()
        .insert(devices)
        .values({ workspaceId: ws.id, label: appVersion ?? "android", tokenHash: randomUUID(), appVersion })
        .returning()
    )[0] as typeof devices.$inferSelect;
  return { ws, route, riva, circle, namaka, bus, android: await mk(null), telegram: await mk("telegram") };
}
type W = Awaited<ReturnType<typeof world>>;

/** A Circle → Namaka trip (km 2→4) with a ping every ~50 m / 5 s; pings between km `dark` arrive 5 min late */
async function leg1Trip(
  w: W,
  day: string,
  o: { device?: typeof devices.$inferSelect; dark?: [number, number]; dep?: string } = {},
) {
  const dep = at(day, o.dep ?? "10:00");
  const n = 40;
  const arr = new Date(dep.getTime() + n * 5000);
  await db()
    .insert(trips)
    .values({
      workspaceId: w.ws.id,
      vehicleId: w.bus.id,
      routeId: w.route.id,
      fromSpotId: w.circle.id,
      toSpotId: w.namaka.id,
      departedAt: dep,
      arrivedAt: arr,
      durationS: n * 5,
      quality: "clean",
    });
  const dev = o.device ?? w.android;
  const rows = Array.from({ length: n + 1 }, (_, i) => {
    const km = 2 + (i / n) * 2;
    const recordedAt = new Date(dep.getTime() + i * 5000);
    const late = o.dark && km >= o.dark[0] && km <= o.dark[1];
    return {
      workspaceId: w.ws.id,
      deviceId: dev.id,
      vehicleId: w.bus.id,
      recordedAt,
      accuracy: 8,
      receivedAt: new Date(recordedAt.getTime() + (late ? 300_000 : 2000)),
      lat: lat(km),
      lng: 73.7,
    };
  });
  await db().insert(pings).values(rows);
}
const stored = async (w: W) => (await db().select().from(routes).where(eq(routes.id, w.route.id)))[0];

describe("recomputeDeadZones", () => {
  it("persists a detected stretch (in route metres) that loadDeadZones then returns", async () => {
    const w = await world();
    for (const d of DAYS) await leg1Trip(w, d, { dark: [2.8, 3.4] });
    const r = await recomputeDeadZones(db(), w.ws.id, NOW);
    expect(r.detected).toBe(1);
    const row = await stored(w);
    expect(row?.noSignalLegs).toHaveLength(1);
    const z = await loadDeadZones(db(), w.ws.id);
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({
      routeId: w.route.id,
      legIndex: 1,
      source: "detected",
      fromSpotId: w.circle.id,
      toSpotId: w.namaka.id,
    });
    // leg 1 starts 2000 m into the path; the dark part is km 2.8–3.4 → 2800–3400 m (± one 50 m bin)
    expect(z[0]?.startAlongM).toBeGreaterThan(2700);
    expect(z[0]?.startAlongM).toBeLessThan(2860);
    expect(z[0]?.endAlongM).toBeGreaterThan(3390);
    expect(z[0]?.endAlongM).toBeLessThan(3500);
  });

  it("a return trip on the same street is projected onto its own leg", async () => {
    const w = await world();
    for (const d of DAYS) {
      const dep = at(d, "11:00");
      const n = 40;
      await db()
        .insert(trips)
        .values({
          workspaceId: w.ws.id,
          vehicleId: w.bus.id,
          routeId: w.route.id,
          fromSpotId: w.namaka.id,
          toSpotId: w.circle.id,
          departedAt: dep,
          arrivedAt: new Date(dep.getTime() + n * 5000),
          durationS: n * 5,
          quality: "clean",
        });
      await db()
        .insert(pings)
        .values(
          Array.from({ length: n + 1 }, (_, i) => {
            const km = 4 - (i / n) * 2;
            const recordedAt = new Date(dep.getTime() + i * 5000);
            const late = km >= 2.8 && km <= 3.4;
            return {
              workspaceId: w.ws.id,
              deviceId: w.android.id,
              vehicleId: w.bus.id,
              recordedAt,
              accuracy: 8,
              lat: lat(km),
              lng: 73.7,
              receivedAt: new Date(recordedAt.getTime() + (late ? 300_000 : 2000)),
            };
          }),
        );
    }
    await recomputeDeadZones(db(), w.ws.id, NOW);
    const z = await loadDeadZones(db(), w.ws.id);
    expect(z.map((x) => x.legIndex)).toEqual([2]);
    // leg 2 spans 4000–6000 m; km 3.4→2.8 on the way back is 4000+(4−3.4)·1000 …
    expect(z[0]?.startAlongM).toBeGreaterThanOrEqual(4500);
    expect(z[0]?.endAlongM).toBeLessThan(5300);
  });

  it("ignores Telegram and Traccar phones, even when they look 'late' or perfectly on time", async () => {
    const w = await world();
    for (const d of DAYS) await leg1Trip(w, d, { device: w.telegram, dark: [2.8, 3.4] });
    expect((await recomputeDeadZones(db(), w.ws.id, NOW)).detected).toBe(0);
    expect(await loadDeadZones(db(), w.ws.id)).toEqual([]);
  });

  it("ignores pings older than the window", async () => {
    const w = await world();
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"])
      await leg1Trip(w, d, { dark: [2.8, 3.4] });
    expect((await recomputeDeadZones(db(), w.ws.id, NOW)).detected).toBe(0);
  });

  it("keeps manual entries untouched, replaces the detected ones, and clears stale detections", async () => {
    const w = await world();
    await db()
      .update(routes)
      .set({
        noSignalLegs: [
          { legIndex: 1, source: "manual" },
          { legIndex: 3, source: "detected", startAlongM: 10, endAlongM: 900, trips: 9, days: 9 },
        ],
      })
      .where(eq(routes.id, w.route.id));
    for (const d of DAYS) await leg1Trip(w, d, { dark: [2.8, 3.4] });
    await recomputeDeadZones(db(), w.ws.id, NOW);
    const legs = (await stored(w))?.noSignalLegs ?? [];
    expect(legs.filter((l) => l.source === "manual")).toEqual([{ legIndex: 1, source: "manual" }]);
    const det = legs.filter((l) => l.source === "detected");
    expect(det.map((l) => l.legIndex)).toEqual([1]); // the stale leg-3 one is gone
    // manual wins when loading
    expect(await loadDeadZones(db(), w.ws.id)).toMatchObject([{ legIndex: 1, source: "manual", startAlongM: null }]);
  });

  it("writes nothing (no version bump, no audit row) when the result is unchanged, and never audits", async () => {
    const w = await world();
    for (const d of DAYS) await leg1Trip(w, d, { dark: [2.8, 3.4] });
    await recomputeDeadZones(db(), w.ws.id, NOW);
    const once = await stored(w);
    await recomputeDeadZones(db(), w.ws.id, NOW);
    const twice = await stored(w);
    expect(twice?.updatedAt).toEqual(once?.updatedAt);
    expect(twice?.version).toBe(w.route.version);
    expect(await db().select().from(auditLog).where(eq(auditLog.workspaceId, w.ws.id))).toHaveLength(0);
  });

  it("does not touch other workspaces", async () => {
    const a = await world();
    const b = await world();
    for (const d of DAYS) await leg1Trip(a, d, { dark: [2.8, 3.4] });
    await recomputeDeadZones(db(), b.ws.id, NOW);
    expect(await loadDeadZones(db(), a.ws.id)).toEqual([]);
  });

  it("skips pings far off the path", async () => {
    const w = await world();
    for (const d of DAYS) await leg1Trip(w, d, { dark: [2.8, 3.4] });
    await db().update(pings).set({ lng: 73.71 }).where(eq(pings.workspaceId, w.ws.id)); // ~1 km sideways
    expect((await recomputeDeadZones(db(), w.ws.id, NOW)).detected).toBe(0);
  });

  it("never re-adds a detected stretch on a leg the admin marked 'has signal', and keeps the mark", async () => {
    const w = await world();
    await db()
      .update(routes)
      .set({ noSignalLegs: [{ legIndex: 1, source: "manual", noSignal: false } as never] })
      .where(eq(routes.id, w.route.id));
    for (const d of DAYS) await leg1Trip(w, d, { dark: [2.8, 3.4] });
    const r = await recomputeDeadZones(db(), w.ws.id, NOW);
    expect(r.detected).toBe(0);
    expect((await stored(w))?.noSignalLegs).toEqual([{ legIndex: 1, source: "manual", noSignal: false }]);
    expect(await loadDeadZones(db(), w.ws.id)).toEqual([]);
    // and again on the next night
    await recomputeDeadZones(db(), w.ws.id, NOW);
    expect(await loadDeadZones(db(), w.ws.id)).toEqual([]);
  });
});
