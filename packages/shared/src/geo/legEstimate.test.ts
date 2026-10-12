import { describe, expect, it } from "vitest";
import { legEstimate } from "./legEstimate";

const DAY = 86_400_000;
// 2026-10-12 12:00 IST (06:30 UTC)
const NOW = Date.UTC(2026, 9, 12, 6, 30);
/** epoch ms at IST hour h (minute 30 of that hour), daysAgo days before NOW's day */
const istAt = (h: number, daysAgo = 0) => Date.UTC(2026, 9, 12 - daysAgo, h, 0) - 5.5 * 3_600_000 + 30 * 60_000;
const at9 = (durationS: number, daysAgo = 1) => ({ durationS, at: istAt(9, daysAgo) });

describe("legEstimate", () => {
  it("≥5 samples in the hour bucket → leg_hour, quantiles from those only", () => {
    const s = [100, 110, 120, 130, 140].map((d) => at9(d));
    const other = [900, 900, 900].map((d) => ({ durationS: d, at: istAt(15, 1) }));
    const r = legEstimate([...s, ...other], { hourBucket: 9, pathM: 3000, now: NOW });
    expect(r.level).toBe("leg_hour");
    expect(r.n).toBe(5);
    expect(r.thin).toBe(false);
    expect(r.medianS).toBe(120);
    expect(r.p80S).toBeLessThanOrEqual(140);
  });

  it("<5 in the hour bucket but some in the window → leg_day, thin when n < 5", () => {
    const r = legEstimate([at9(100), at9(200), { durationS: 300, at: istAt(15, 1) }], {
      hourBucket: 9,
      pathM: 3000,
      now: NOW,
    });
    expect(r.level).toBe("leg_day");
    expect(r.n).toBe(3);
    expect(r.thin).toBe(true);
    expect(r.medianS).toBe(200);
  });

  it("no samples → baseline: pathM ÷ 25 km/h, n 0, thin", () => {
    const r = legEstimate([], { hourBucket: 9, pathM: 5000, now: NOW });
    expect(r).toEqual({ medianS: 720, p20S: 720, p80S: 720, n: 0, level: "baseline", thin: true });
  });

  it("no samples and pathM 0 (dwell) → baselineDwellS", () => {
    expect(legEstimate([], { hourBucket: 9, pathM: 0, now: NOW }).medianS).toBe(180);
    expect(legEstimate([], { hourBucket: 9, pathM: 0, now: NOW, baselineDwellS: 60 }).p80S).toBe(60);
  });

  it("samples older than 7 days are ignored", () => {
    const r = legEstimate([at9(100, 8), { durationS: 999, at: NOW - 7 * DAY - 1 }], {
      hourBucket: 9,
      pathM: 5000,
      now: NOW,
    });
    expect(r.level).toBe("baseline");
    // samples after now are ignored too
    expect(legEstimate([{ durationS: 50, at: NOW + 1000 }], { hourBucket: 9, pathM: 5000, now: NOW }).level).toBe(
      "baseline",
    );
  });

  it("newer samples weigh more than older ones", () => {
    // two old slow, two fresh fast: unweighted median would sit between; weighted leans fast
    const r = legEstimate([at9(300, 6), at9(300, 6), at9(100, 0), at9(100, 0)], { hourBucket: 9, pathM: 0, now: NOW });
    expect(r.medianS).toBe(100);
    const r2 = legEstimate([at9(300, 0), at9(300, 0), at9(100, 6), at9(100, 6)], {
      hourBucket: 9,
      pathM: 0,
      now: NOW,
    });
    expect(r2.medianS).toBe(300);
  });

  it("hour bucket uses IST hour of the sample (02:00 UTC is 07:30 IST → bucket 7)", () => {
    const at = Date.UTC(2026, 9, 11, 2, 0);
    const s = Array.from({ length: 5 }, () => ({ durationS: 200, at }));
    expect(legEstimate(s, { hourBucket: 7, pathM: 0, now: NOW }).level).toBe("leg_hour");
    expect(legEstimate(s, { hourBucket: 2, pathM: 0, now: NOW }).level).toBe("leg_day");
  });

  it("custom minSamples / baselineKmh / windowDays", () => {
    expect(legEstimate([at9(100), at9(110)], { hourBucket: 9, pathM: 0, now: NOW, minSamples: 2 })).toMatchObject({
      level: "leg_hour",
      thin: false,
    });
    expect(legEstimate([], { hourBucket: 9, pathM: 5000, now: NOW, baselineKmh: 50 }).medianS).toBe(360);
    expect(legEstimate([at9(100, 3)], { hourBucket: 9, pathM: 5000, now: NOW, windowDays: 2 }).level).toBe(
      "baseline",
    );
  });

  it("p20 ≤ median ≤ p80", () => {
    const s = [90, 400, 130, 95, 200, 160, 105, 300, 120, 140].map((d, i) => at9(d, i % 7));
    const r = legEstimate(s, { hourBucket: 9, pathM: 0, now: NOW });
    expect(r.p20S).toBeLessThanOrEqual(r.medianS);
    expect(r.medianS).toBeLessThanOrEqual(r.p80S);
    expect(r.p20S).toBeLessThan(r.p80S);
  });

  it("single sample → all three quantiles equal it", () => {
    const r = legEstimate([at9(222)], { hourBucket: 9, pathM: 3000, now: NOW });
    expect(r).toEqual({ medianS: 222, p20S: 222, p80S: 222, n: 1, level: "leg_day", thin: true });
  });
});
