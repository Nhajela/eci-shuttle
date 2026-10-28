import { describe, expect, it } from "vitest";
import { BIN_M, type DetectLeg, type DetectPing, detectStretches, LATE_S, MIN_DAYS, MIN_TRIPS } from "./detect";

// one leg of 1000 m (0..1000) and one of 600 m (1000..1600)
const LEGS: DetectLeg[] = [
  { legIndex: 0, startM: 0, endM: 1000 },
  { legIndex: 1, startM: 1000, endM: 1600 },
];

/** a trip's pings every 25 m through [from, to]; late between darkFrom and darkTo */
function trip(
  id: string,
  day: string,
  o: { legIndex: number; from: number; to: number; dark?: [number, number]; device?: string },
): DetectPing[] {
  const out: DetectPing[] = [];
  for (let m = o.from; m <= o.to; m += 25) {
    const late = o.dark && m >= o.dark[0] && m <= o.dark[1];
    out.push({
      tripId: id,
      day,
      deviceId: o.device ?? "d1",
      legIndex: o.legIndex,
      alongM: m,
      lateS: late ? 400 : 2,
    });
  }
  return out;
}
const DAYS = ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"];

describe("detectStretches", () => {
  it("finds a late-arriving stretch seen by several trips on several days", () => {
    const pings = DAYS.flatMap((d, i) => trip(`t${i}`, d, { legIndex: 0, from: 0, to: 1000, dark: [400, 700] }));
    const r = detectStretches(pings, LEGS);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ legIndex: 0, trips: 4, days: 4 });
    expect(r[0]?.startAlongM).toBeGreaterThanOrEqual(400 - BIN_M);
    expect(r[0]?.startAlongM).toBeLessThanOrEqual(400);
    expect(r[0]?.endAlongM).toBeGreaterThanOrEqual(700);
    expect(r[0]?.endAlongM).toBeLessThanOrEqual(700 + BIN_M);
  });

  it("detects the pings physical stretch on the return leg independently", () => {
    const pings = DAYS.flatMap((d, i) => [
      ...trip(`a${i}`, d, { legIndex: 0, from: 0, to: 1000, dark: [400, 700] }),
      ...trip(`b${i}`, d, { legIndex: 1, from: 1000, to: 1600, dark: [1100, 1500] }),
    ]);
    expect(detectStretches(pings, LEGS).map((s) => s.legIndex)).toEqual([0, 1]);
  });

  it("needs several trips: fewer than MIN_TRIPS is not enough", () => {
    const pings = DAYS.slice(0, MIN_TRIPS - 1).flatMap((d, i) =>
      trip(`t${i}`, d, { legIndex: 0, from: 0, to: 1000, dark: [400, 700] }),
    );
    expect(detectStretches(pings, LEGS)).toEqual([]);
  });

  it("needs several days: many trips on one day are not enough", () => {
    expect(MIN_DAYS).toBeGreaterThan(1);
    const pings = [0, 1, 2, 3, 4].flatMap((i) =>
      trip(`t${i}`, "2026-10-26", { legIndex: 0, from: 0, to: 1000, dark: [400, 700] }),
    );
    expect(detectStretches(pings, LEGS)).toEqual([]);
  });

  it("ignores lateness that only some trips show (a one-off upload delay)", () => {
    const pings = DAYS.flatMap((d, i) =>
      trip(`t${i}`, d, { legIndex: 0, from: 0, to: 1000, dark: i === 0 ? [400, 700] : undefined }),
    );
    // more clean trips on the pings days
    const clean = DAYS.flatMap((d, i) => trip(`c${i}`, d, { legIndex: 0, from: 0, to: 1000 }));
    expect(detectStretches([...pings, ...clean], LEGS)).toEqual([]);
  });

  it("pings within LATE_S are on time", () => {
    const pings = DAYS.flatMap((d, i) => trip(`t${i}`, d, { legIndex: 0, from: 0, to: 1000 })).map((p) => ({
      ...p,
      lateS: LATE_S,
    }));
    expect(detectStretches(pings, LEGS)).toEqual([]);
  });

  it("drops stretches shorter than a few bins (GPS jitter, one slow upload)", () => {
    const pings = DAYS.flatMap((d, i) => trip(`t${i}`, d, { legIndex: 0, from: 0, to: 1000, dark: [500, 520] }));
    expect(detectStretches(pings, LEGS)).toEqual([]);
  });

  it("ignores a phone whose pings are late everywhere (batching uploads, not a dead zone)", () => {
    const pings = DAYS.flatMap((d, i) => trip(`t${i}`, d, { legIndex: 0, from: 0, to: 1000, dark: [0, 1000] }));
    expect(detectStretches(pings, LEGS)).toEqual([]);
  });

  it("a whole dark leg is still found when the phone is on time elsewhere", () => {
    const pings = DAYS.flatMap((d, i) => [
      ...trip(`t${i}`, d, { legIndex: 1, from: 1000, to: 1600, dark: [1000, 1600] }),
      ...trip(`u${i}`, d, { legIndex: 0, from: 0, to: 1000 }),
      ...trip(`v${i}`, d, { legIndex: 0, from: 0, to: 1000 }),
    ]);
    const r = detectStretches(pings, LEGS);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ legIndex: 1, startAlongM: 1000, endAlongM: 1600 });
  });

  it("bridges a single clean bin inside a dark stretch", () => {
    const pings = DAYS.flatMap((d, i) =>
      trip(`z${i}`, d, { legIndex: 0, from: 0, to: 1000 }).map((p) =>
        p.alongM >= 300 && p.alongM <= 650 && (p.alongM < 450 || p.alongM >= 500) ? { ...p, lateS: 300 } : p,
      ),
    );
    const r = detectStretches(pings, LEGS);
    expect(r).toHaveLength(1);
    expect(r[0]?.startAlongM).toBeLessThanOrEqual(300);
    expect(r[0]?.endAlongM).toBeGreaterThanOrEqual(650);
  });

  it("returns nothing for no pings", () => {
    expect(detectStretches([], LEGS)).toEqual([]);
  });
});
