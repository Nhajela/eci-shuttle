import { describe, expect, it } from "vitest";
import type { LegEstimate } from "../contracts";
import { PLANNED_DWELL_DEFAULT, plannedDwellS, withPlannedDwell } from "./plannedDwell";

const est = (medianS: number, n: number, level: LegEstimate["level"] = "leg_day"): LegEstimate => ({
  medianS,
  p20S: medianS,
  p80S: medianS,
  n,
  level,
  thin: n < 5,
});

describe("plannedDwellS", () => {
  it("is the spot's own entry, else the route default ('*'), else undefined", () => {
    const plan = { [PLANNED_DWELL_DEFAULT]: 300, riva: 120, beach: 0 };
    expect(plannedDwellS(plan, "riva")).toBe(120);
    expect(plannedDwellS(plan, "beach")).toBe(0);
    expect(plannedDwellS(plan, "circle")).toBe(300);
    expect(plannedDwellS({ riva: 120 }, "circle")).toBeUndefined();
    expect(plannedDwellS({}, "riva")).toBeUndefined();
  });
});

describe("withPlannedDwell", () => {
  it("uses the plan over the baseline and over thin learned dwells", () => {
    expect(withPlannedDwell(est(180, 0, "baseline"), 300)).toEqual({
      medianS: 300,
      p20S: 300,
      p80S: 300,
      n: 0,
      level: "baseline",
      thin: true,
    });
    expect(withPlannedDwell(est(40, 3), 300)?.medianS).toBe(300);
    expect(withPlannedDwell(undefined, 300)?.medianS).toBe(300);
  });

  it("learned dwell wins once it has enough samples", () => {
    expect(withPlannedDwell(est(240, 5, "leg_hour"), 300)).toEqual(est(240, 5, "leg_hour"));
  });

  it("without a plan keeps the estimate as is", () => {
    expect(withPlannedDwell(est(40, 3), undefined)).toEqual(est(40, 3));
    expect(withPlannedDwell(undefined, undefined)).toBeUndefined();
  });
});
