import { describe, expect, it } from "vitest";
import type { EtaInput, EtaLeg, LegEstimate } from "../contracts";
import { etaToSpot } from "./eta";

const NOW = Date.UTC(2026, 9, 12, 6, 0, 0);

const est = (medianS: number, p20S = medianS, p80S = medianS, thin = false): LegEstimate => ({
  medianS,
  p20S,
  p80S,
  n: thin ? 1 : 10,
  level: thin ? "leg_day" : "leg_hour",
  thin,
});

const leg = (fromSpotId: string, toSpotId: string, medianS: number, extra: Partial<EtaLeg> = {}): EtaLeg => ({
  fromSpotId,
  toSpotId,
  lengthM: 1000,
  estimate: est(medianS),
  ...extra,
});

// Riva → Circle → Market (A → B → C), 10 / 20 min legs, 2 min dwell at Circle
const line = (over: Partial<EtaInput> = {}): EtaInput => ({
  legs: [leg("riva", "circle", 600), leg("circle", "market", 1200)],
  dwells: { riva: est(60), circle: est(120), market: est(300) },
  vehicle: { kind: "en_route", legIndex: 0, alongLegM: 0 },
  targetSpotId: "market",
  loop: false,
  now: NOW,
  ...over,
});

describe("etaToSpot", () => {
  it("halfway along the only leg → half the leg median", () => {
    const r = etaToSpot({
      legs: [leg("a", "b", 600)],
      dwells: {},
      vehicle: { kind: "en_route", legIndex: 0, alongLegM: 500 },
      targetSpotId: "b",
      loop: false,
      now: NOW,
    });
    expect(r).toMatchObject({ seconds: 300, minutes: 5, legsChained: 1, basis: "learned" });
  });

  it("segment speeds override the proportional estimate where they cover the remaining path", () => {
    // remaining 500 m: 400..1000 covered at 2 m/s (only 500..1000 is ahead → 250 s), nothing uncovered
    const r = etaToSpot({
      legs: [leg("a", "b", 600, { segments: [{ startM: 400, endM: 1000, medianMps: 2 }] })],
      dwells: {},
      vehicle: { kind: "en_route", legIndex: 0, alongLegM: 500 },
      targetSpotId: "b",
      loop: false,
      now: NOW,
    });
    expect(r?.seconds).toBe(250);

    // partial cover: 500..700 at 2 m/s (100 s) + 300 m uncovered at 0.6 s/m (180 s)
    const r2 = etaToSpot({
      legs: [leg("a", "b", 600, { segments: [{ startM: 0, endM: 700, medianMps: 2 }] })],
      dwells: {},
      vehicle: { kind: "en_route", legIndex: 0, alongLegM: 500 },
      targetSpotId: "b",
      loop: false,
      now: NOW,
    });
    expect(r2?.seconds).toBe(280);
  });

  it("at the target spot → 0 min, legsChained 0", () => {
    const r = etaToSpot(line({ vehicle: { kind: "at_spot", spotIndex: 2, since: NOW - 60_000 } }));
    expect(r).toEqual({ seconds: 0, minutes: 0, lo: 0, hi: 0, basis: "learned", legsChained: 0 });
  });

  it("at another spot → remaining dwell + following legs", () => {
    // at Circle for 30 s of a 120 s dwell → 90 + 1200
    const r = etaToSpot(line({ vehicle: { kind: "at_spot", spotIndex: 1, since: NOW - 30_000 } }));
    expect(r).toMatchObject({ seconds: 1290, minutes: 22, legsChained: 1 });
  });

  it("remaining dwell never goes negative after overstaying", () => {
    const r = etaToSpot(line({ vehicle: { kind: "at_spot", spotIndex: 1, since: NOW - 3_600_000 } }));
    expect(r?.seconds).toBe(1200);
  });

  it("chains legs and dwells through intermediate spots (Here in 34 min)", () => {
    // from Riva start: 600 + dwell Circle 120 + 1200 = 1920 s ≈ 32 min; from Riva dwell (60 s left) → 34 min
    const r = etaToSpot(line({ vehicle: { kind: "at_spot", spotIndex: 0, since: NOW } }));
    expect(r).toMatchObject({ seconds: 1980, minutes: 33, legsChained: 2 });
    const r2 = etaToSpot(
      line({
        dwells: { riva: est(180), circle: est(120) },
        vehicle: { kind: "at_spot", spotIndex: 0, since: NOW },
      }),
    );
    expect(r2?.minutes).toBe(35);
    expect(etaToSpot(line())?.minutes).toBe(32);
  });

  it("Riva → Circle → Riva: target Riva while on leg 0 → the second occurrence", () => {
    const r = etaToSpot({
      legs: [leg("riva", "circle", 600), leg("circle", "riva", 900)],
      dwells: { circle: est(120) },
      vehicle: { kind: "en_route", legIndex: 0, alongLegM: 0 },
      targetSpotId: "riva",
      loop: false,
      now: NOW,
    });
    expect(r).toMatchObject({ seconds: 1620, minutes: 27, legsChained: 2 });
  });

  it("loop: past the last spot wraps to leg 0", () => {
    // on the last leg (circle → market), target circle: rest of leg 1, dwell market, then wrap: riva→circle needs
    // a closing leg market → riva in a real loop; here legs are a ring a→b→c→a
    const ring: EtaLeg[] = [leg("a", "b", 600), leg("b", "c", 600), leg("c", "a", 600)];
    const r = etaToSpot({
      legs: ring,
      dwells: { a: est(60), b: est(60), c: est(60) },
      vehicle: { kind: "en_route", legIndex: 2, alongLegM: 500 },
      targetSpotId: "b",
      loop: true,
      now: NOW,
    });
    // 300 + dwell a 60 + 600
    expect(r).toMatchObject({ seconds: 960, minutes: 16, legsChained: 2 });

    // at the last spot of a loop route → continues from leg 0
    const r2 = etaToSpot({
      legs: ring,
      dwells: { a: est(60), b: est(60), c: est(60) },
      vehicle: { kind: "at_spot", spotIndex: 3, since: NOW },
      targetSpotId: "b",
      loop: true,
      now: NOW,
    });
    expect(r2).toMatchObject({ seconds: 660, legsChained: 1 });

    // target just behind → at most one full lap
    const r3 = etaToSpot({
      legs: ring,
      dwells: { a: est(60), b: est(60), c: est(60) },
      vehicle: { kind: "en_route", legIndex: 1, alongLegM: 0 },
      targetSpotId: "b",
      loop: true,
      now: NOW,
    });
    expect(r3).toMatchObject({ seconds: 600 * 3 + 60 * 2, legsChained: 3 });
  });

  it("not loop and target behind → null", () => {
    expect(
      etaToSpot(line({ vehicle: { kind: "en_route", legIndex: 1, alongLegM: 10 }, targetSpotId: "riva" })),
    ).toBeNull();
    expect(
      etaToSpot(line({ vehicle: { kind: "at_spot", spotIndex: 2, since: NOW }, targetSpotId: "circle" })),
    ).toBeNull();
  });

  it("target not on the route → null", () => {
    expect(etaToSpot(line({ targetSpotId: "nowhere" }))).toBeNull();
    expect(etaToSpot(line({ targetSpotId: "nowhere", loop: true }))).toBeNull();
  });

  it("legIndex out of range → null", () => {
    expect(etaToSpot(line({ vehicle: { kind: "en_route", legIndex: 2, alongLegM: 0 } }))).toBeNull();
    expect(etaToSpot(line({ vehicle: { kind: "en_route", legIndex: -1, alongLegM: 0 } }))).toBeNull();
    expect(etaToSpot(line({ vehicle: { kind: "at_spot", spotIndex: 3, since: NOW } }))).toBeNull();
    expect(etaToSpot(line({ legs: [] }))).toBeNull();
  });

  it("lo ≤ minutes ≤ hi, built from p20 / p80", () => {
    const r = etaToSpot({
      legs: [
        { ...leg("a", "b", 600), estimate: est(600, 480, 900) },
        { ...leg("b", "c", 600), estimate: est(600, 540, 720) },
      ],
      dwells: { b: est(120, 60, 240) },
      vehicle: { kind: "en_route", legIndex: 0, alongLegM: 500 },
      targetSpotId: "c",
      loop: false,
      now: NOW,
    });
    // median 300 + 120 + 600 = 1020 (17); p20 240 + 60 + 540 = 840 (14); p80 450 + 240 + 720 = 1410 (24)
    expect(r).toMatchObject({ seconds: 1020, minutes: 17, lo: 14, hi: 24 });

    // at a spot past its p20 dwell: lo clamps to 0 for the dwell, never above minutes
    const r2 = etaToSpot({
      legs: [{ ...leg("a", "b", 600), estimate: est(600, 480, 900) }],
      dwells: { a: est(120, 60, 240) },
      vehicle: { kind: "at_spot", spotIndex: 0, since: NOW - 90_000 },
      targetSpotId: "b",
      loop: false,
      now: NOW,
    });
    expect(r2).toMatchObject({ seconds: 630, lo: 8, hi: 18 });
    expect(r2 && r2.lo <= r2.minutes && r2.minutes <= r2.hi).toBe(true);
  });

  it("any thin estimate → basis estimate; all solid → learned", () => {
    expect(etaToSpot(line())?.basis).toBe("learned");
    expect(etaToSpot(line({ dwells: { circle: est(120, 120, 120, true) } }))?.basis).toBe("estimate");
    const thinLeg = line({
      legs: [leg("riva", "circle", 600), { ...leg("circle", "market", 1200), estimate: est(1200, 1200, 1200, true) }],
    });
    expect(etaToSpot(thinLeg)?.basis).toBe("estimate");
    // a missing dwell falls back to the baseline dwell (180 s), which is thin
    const r = etaToSpot(line({ dwells: {} }));
    expect(r).toMatchObject({ seconds: 600 + 180 + 1200, basis: "estimate" });
  });
});
