import type { Ping } from "@eci-shuttle/shared";
import { makeOutAndBack, pointAt, STOP_KM } from "@tests/factories/repeated-stops";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { departureMatches, routes, services, vehicleState } from "@/db/schema";
import { ingestPings } from "./ingest";

const db = () => testDb();
const T0 = Date.parse("2026-10-13T09:00:00+05:30");
const ping = (at: number, km: number): Ping => {
  const p = pointAt(km);
  return { recordedAt: at, lat: p.lat, lng: p.lng, accuracy: 8, speed: null, heading: null, battery: 80 };
};

/** Drives the whole out-and-back lap (and the start of the next): 60 s at every stop, 120 s per 1 km leg, a ping every 10 s. */
function lap(laps = 1) {
  const batches: {
    label: string;
    pings: Ping[];
    expect: { phase: "at_spot" | "en_route"; k: number; frac?: number };
  }[] = [];
  let t = T0;
  for (let l = 0; l < laps; l++) {
    for (let i = 0; i < STOP_KM.length; i++) {
      const km = STOP_KM[i] as number;
      const stopPings: Ping[] = [];
      for (let s = 0; s < 60; s += 10) stopPings.push(ping(t + s * 1000, km));
      batches.push({ label: `lap ${l} dwell ${i}`, pings: stopPings, expect: { phase: "at_spot", k: i } });
      t += 60_000;
      if (i === STOP_KM.length - 1 && l === laps - 1) break;
      const next = STOP_KM[i + 1] ?? STOP_KM[1];
      const toKm = i === STOP_KM.length - 1 ? 1 : (next as number);
      const fromKm = km;
      const leg = i === STOP_KM.length - 1 ? 0 : i;
      // 25 % and 75 % of the leg: far enough out of the 75 m geofence to have departed
      for (const f of [0.25, 0.75]) {
        const pts: Ping[] = [];
        for (let s = 0; s < 120; s += 10) {
          const frac = s / 120;
          if (frac > f + 1e-9 || frac <= f - 0.2) continue;
          pts.push(ping(t + s * 1000, fromKm + (toKm - fromKm) * frac));
        }
        batches.push({
          label: `lap ${l} leg ${leg} at ${f}`,
          pings: pts,
          expect: { phase: "en_route", k: leg, frac: f },
        });
      }
      // the rest of the leg, arriving is the next dwell batch
      const rest: Ping[] = [];
      for (let s = 0; s < 120; s += 10) {
        const frac = s / 120;
        if (frac > 0.75 + 1e-9) rest.push(ping(t + s * 1000, fromKm + (toKm - fromKm) * frac));
      }
      batches.push({ label: `lap ${l} leg ${leg} end`, pings: rest, expect: { phase: "en_route", k: leg } });
      t += 120_000;
    }
  }
  return batches;
}

describe("ingest on a route that repeats stops (out and back)", () => {
  it("at every point of the lap, next spot, alongM and eta follow the leg the vehicle is really on", async () => {
    const w = await makeOutAndBack(db());
    const ids = w.route.spotIds;
    const state = async () =>
      (await db().select().from(vehicleState).where(eq(vehicleState.vehicleId, w.vehicle.id)))[0];
    const send = (pings: Ping[]) =>
      ingestPings(
        db(),
        { workspaceId: w.ws.id, deviceId: w.device.id, pings },
        new Date((pings.at(-1)?.recordedAt ?? 0) + 2_000),
      );
    const LEG_S = 144; // 1 km at the 25 km/h baseline

    for (const b of lap(2)) {
      await send(b.pings);
      const s = await state();
      const { phase, k, frac } = b.expect;
      const ctx = `${b.label}: ${JSON.stringify({ phase: s.phase, spotId: s.spotId, next: s.nextSpotId, along: s.alongM, eta: s.etaS })}`;
      expect(s.phase, ctx).toBe(phase);
      if (phase === "at_spot") {
        // waiting at spot k: the next stop is the one after it (the loop's end heads back to Riva)
        const wantFrom = k;
        const wantNext = ids[k + 1] ?? ids[1];
        expect(s.spotId, ctx).toBe(ids[wantFrom]);
        expect(s.nextSpotId, ctx).toBe(wantNext);
        // at a stop alongM is the stop's own position (the lap start for the loop's end)
        expect(s.alongM, ctx).toBeCloseTo(k === ids.length - 1 ? 0 : (w.cumM[k] as number), -1);
      } else {
        expect(s.spotId, ctx).toBe(ids[k]);
        expect(s.nextSpotId, ctx).toBe(ids[k + 1]);
        if (frac !== undefined) {
          const legM = (w.cumM[k + 1] as number) - (w.cumM[k] as number);
          expect(s.alongM, ctx).toBeCloseTo((w.cumM[k] as number) + legM * frac, -2);
          expect(s.etaS ?? -1, ctx).toBeGreaterThan(LEG_S * (1 - frac) - 15);
          expect(s.etaS ?? 1e9, ctx).toBeLessThan(LEG_S * (1 - frac) + 15);
        }
      }
    }
  });

  it("leaving Circle southbound after Namaka: next is Riva (leg 4), not Namaka", async () => {
    const w = await makeOutAndBack(db());
    const batches = lap(1);
    const stop = batches.findIndex((x) => x.label === "lap 0 leg 4 at 0.25");
    for (const b of batches.slice(0, stop + 1))
      await ingestPings(
        db(),
        { workspaceId: w.ws.id, deviceId: w.device.id, pings: b.pings },
        new Date((b.pings.at(-1)?.recordedAt ?? 0) + 2_000),
      );
    const [s] = await db().select().from(vehicleState).where(eq(vehicleState.vehicleId, w.vehicle.id));
    expect(s).toMatchObject({ phase: "en_route", spotId: w.id.circle, nextSpotId: w.id.riva });
    expect(s.alongM).toBeGreaterThan(w.cumM[4] as number);
    expect(s.alongM).toBeLessThan(w.cumM[5] as number);
  });
});

describe("departure matching on a route whose first stop reappears mid-route", () => {
  it("only a departure from the first occurrence is matched against the timetable", async () => {
    // Nanu → Riva → Nanu → Circle (one way): the 09:07 departure from Nanu is leg 2, not a timetable departure
    const w = await makeOutAndBack(db(), { pattern: "times" });
    const { nanu, riva, circle } = w.id;
    await db()
      .update(routes)
      .set({ spotIds: [nanu, riva, nanu, circle], path: [0, 1, 0, 2].map(pointAt), spotPathIdx: [0, 1, 2, 3] })
      .where(eq(routes.id, w.route.id));
    await db()
      .update(services)
      .set({ pattern: { kind: "times", times: ["09:00", "09:10"] } })
      .where(eq(services.id, w.service.id));
    const at = (hhmmss: string) => Date.parse(`2026-10-13T${hhmmss}+05:30`);
    const fixes = (from: string, to: string, a: number, b = a) => {
      const out: Ping[] = [];
      for (let t = at(from); t <= at(to); t += 10_000)
        out.push(ping(t, a + ((b - a) * (t - at(from))) / (at(to) - at(from))));
      return out;
    };
    const all = [
      ...fixes("08:58:00", "09:01:00", 0),
      ...fixes("09:01:10", "09:03:00", 0, 1),
      ...fixes("09:03:10", "09:04:00", 1),
      ...fixes("09:04:10", "09:06:00", 1, 0),
      ...fixes("09:06:10", "09:07:00", 0),
      ...fixes("09:07:10", "09:08:30", 0, 0.7),
    ];
    await ingestPings(db(), { workspaceId: w.ws.id, deviceId: w.device.id, pings: all }, new Date(at("09:08:40")));
    const rows = await db().select().from(departureMatches).where(eq(departureMatches.serviceId, w.service.id));
    expect(rows.map((r) => r.plannedAt.getTime())).toEqual([at("09:00:00")]);
    expect(rows[0]?.dwellId).not.toBeNull();
  });
});

/** Waypoints in km along the road: dwell `dwellS` at each, `legS` seconds between, a fix every `stepS`. */
function walk(stopsKm: number[], opts: { stepS?: number; dwellS?: number; legS?: number; t0?: number } = {}) {
  const { stepS = 10, dwellS = 60, legS = 120 } = opts;
  let t = opts.t0 ?? T0;
  const out: Ping[] = [];
  stopsKm.forEach((km, i) => {
    for (let s = 0; s < dwellS; s += stepS) out.push(ping(t + s * 1000, km));
    t += dwellS * 1000;
    const next = stopsKm[i + 1];
    if (next === undefined) return;
    for (let s = 0; s < legS; s += stepS) out.push(ping(t + s * 1000, km + (next - km) * (s / legS)));
    t += legS * 1000;
  });
  return { pings: out, end: t };
}

describe("ingest: the position outranks the dwell log when they disagree", () => {
  const send = (w: Awaited<ReturnType<typeof makeOutAndBack>>, pings: Ping[]) =>
    ingestPings(
      db(),
      { workspaceId: w.ws.id, deviceId: w.device.id, pings },
      new Date((pings.at(-1)?.recordedAt ?? 0) + 2_000),
    );
  const stateOf = async (w: Awaited<ReturnType<typeof makeOutAndBack>>) =>
    (await db().select().from(vehicleState).where(eq(vehicleState.vehicleId, w.vehicle.id)))[0];

  it("ops run Circle → Namaka → Circle → Namaka again: heading north from Circle the van is on leg 2, not Circle → Riva", async () => {
    const w = await makeOutAndBack(db());
    // Circle (2), Namaka (3), Circle (2), then 90 % of the way to Namaka again
    const run = walk([2, 3, 2]);
    const second = walk([2, 2.9], { t0: run.end, dwellS: 0, legS: 120 }); // leaves Circle at once, north
    await send(w, [...run.pings, ...second.pings.filter((p) => p.recordedAt > run.end + 40_000)]);
    const s = await stateOf(w);
    expect(s).toMatchObject({ phase: "en_route", spotId: w.id.circle, nextSpotId: w.id.namaka });
    expect(s.alongM).toBeGreaterThan(w.cumM[2] as number);
    expect(s.alongM).toBeLessThan(w.cumM[3] as number);
    // Namaka is ~100 m ahead: minutes away at most, not a van driving away from Riva
    expect(s.etaS ?? 1e9).toBeLessThan(60);
  });

  it("turning round before the next geofence: on the shared road the position cannot tell the passes apart (documented)", async () => {
    const w = await makeOutAndBack(db());
    // Nanu → Riva → Circle, then north 0.5 km and back south again without reaching Namaka
    const run = walk([0, 1, 2]);
    const turn = walk([2.5, 2.2], { t0: run.end, dwellS: 0, legS: 60 });
    await send(w, [...run.pings, ...walk([2, 2.5], { t0: run.end, dwellS: 0, legS: 60 }).pings, ...turn.pings]);
    const s = await stateOf(w);
    // still the last dwell's leg (Circle → Namaka): the van is on that road, within the geofence-free stretch
    expect(s).toMatchObject({ phase: "en_route", spotId: w.id.circle, nextSpotId: w.id.namaka });
    // its next arrival (Riva) puts it back on the return half through the dwell log
    const back = walk([2.2, 1], { t0: turn.end, dwellS: 0, legS: 120 });
    await send(w, [...back.pings, ...walk([1], { t0: back.end }).pings]);
    expect(await stateOf(w)).toMatchObject({ phase: "at_spot", spotId: w.id.riva, nextSpotId: w.id.nanu });
  });

  it("a lap with one fix a minute still resolves every pass", async () => {
    const w = await makeOutAndBack(db());
    const ids = w.route.spotIds;
    // stop by stop: after the dwell fixes of stop i the van is at spot i; after the first leg fix it is on leg i
    let t = T0;
    for (let i = 0; i < 7; i++) {
      const km = [0, 1, 2, 3, 2, 1, 0][i] as number;
      await send(w, [ping(t, km), ping(t + 60_000, km), ping(t + 120_000, km)]);
      const s = await stateOf(w);
      expect(s, `dwell ${i}`).toMatchObject({ phase: "at_spot", spotId: ids[i] });
      expect(s.nextSpotId, `dwell ${i}`).toBe(ids[i + 1] ?? ids[1]);
      t += 180_000;
      if (i === 6) break;
      const nextKm = [0, 1, 2, 3, 2, 1, 0][i + 1] as number;
      await send(w, [ping(t - 30_000, km + (nextKm - km) * 0.3), ping(t + 30_000, km + (nextKm - km) * 0.7)]);
      const m = await stateOf(w);
      expect(m, `leg ${i}`).toMatchObject({ phase: "en_route", spotId: ids[i], nextSpotId: ids[i + 1] });
      t += 60_000;
    }
  });
});
