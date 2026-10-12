import { describe, expect, it } from "vitest";
import { buildPlan, haversineM, positionAt } from "./plan";

const A = { lat: 15.65, lng: 73.7 };
const B = { lat: 15.66, lng: 73.7 };
const C = { lat: 15.67, lng: 73.7 };

describe("buildPlan / positionAt", () => {
  it("open route: dwells at each stop, drives each leg, then drives back", () => {
    const plan = buildPlan({ path: [A, B, C], spotPathIdx: [0, 2], typicalLegS: [600] }, { dwellS: 60, kmh: 25 });
    // dwell A, learned 600 s leg, dwell C, drive back at 25 km/h
    expect(plan.totalS).toBeCloseTo(60 + 600 + 60 + haversineM(A, C) / (25 / 3.6), 0);
    expect(positionAt(plan, 30)).toMatchObject({ lat: A.lat, lng: A.lng, speedMps: 0 });
    const mid = positionAt(plan, 60 + 300);
    expect(mid.lat).toBeCloseTo(B.lat, 3);
    expect(mid.speedMps).toBeGreaterThan(0);
    expect(mid.heading).toBeCloseTo(0, 0);
    expect(positionAt(plan, 60 + 600 + 30)).toMatchObject({ lat: C.lat, speedMps: 0 });
    expect(positionAt(plan, plan.totalS - 1).heading).toBeCloseTo(180, 0);
    // cycles forever
    expect(positionAt(plan, plan.totalS + 30)).toMatchObject({ lat: A.lat, speedMps: 0 });
  });

  it("closed loop route: no drive back, one dwell at the shared start/end", () => {
    const plan = buildPlan({ path: [A, B, C, B, A], spotPathIdx: [0, 2, 4], typicalLegS: [] }, { dwellS: 60, kmh: 36 });
    const leg = haversineM(A, C) / 10;
    expect(plan.totalS).toBeCloseTo(60 + leg + 60 + leg, 0);
    expect(positionAt(plan, 60 + leg + 30)).toMatchObject({ lat: C.lat, speedMps: 0 });
  });

  it("no spot indexes: drives the whole path with stops at its ends", () => {
    const plan = buildPlan({ path: [A, C], spotPathIdx: [], typicalLegS: [] }, { dwellS: 10, kmh: 36 });
    expect(positionAt(plan, 5)).toMatchObject({ lat: A.lat });
    expect(plan.totalS).toBeCloseTo(10 + 10 + (2 * haversineM(A, C)) / 10, 0);
  });

  it("refuses a path with fewer than two points", () => {
    expect(() => buildPlan({ path: [A], spotPathIdx: [], typicalLegS: [] }, { dwellS: 10, kmh: 25 })).toThrow(/path/);
  });
});
