import { describe, expect, it } from "vitest";
import { averageWait, headwaysFromDepartures } from "./averageWait";

const MIN = 60;
const MIN_MS = 60_000;

describe("averageWait", () => {
  it("equal headways of 20 min → 10 min", () => {
    expect(averageWait([20 * MIN, 20 * MIN, 20 * MIN])).toBe(10 * MIN);
  });
  it("10 and 30 min headways → 12.5 min (longer than half the 20 min mean)", () => {
    expect(averageWait([10 * MIN, 30 * MIN])).toBe(12.5 * MIN);
  });
  it("empty → null", () => {
    expect(averageWait([])).toBeNull();
  });
  it("zero, negative and NaN headways are ignored", () => {
    expect(averageWait([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 20 * MIN])).toBe(10 * MIN);
    expect(averageWait([0, -5, Number.NaN])).toBeNull();
  });
  it("single headway H → H / 2", () => {
    expect(averageWait([900])).toBe(450);
  });
});

describe("headwaysFromDepartures", () => {
  const t0 = Date.UTC(2026, 9, 12, 4, 0); // 09:30 IST
  it("gaps between consecutive departures, in seconds", () => {
    expect(headwaysFromDepartures([t0, t0 + 10 * MIN_MS, t0 + 40 * MIN_MS])).toEqual([10 * MIN, 30 * MIN]);
  });
  it("unsorted input is sorted first and the input is not mutated", () => {
    const input = [t0 + 30 * MIN_MS, t0, t0 + 10 * MIN_MS];
    expect(headwaysFromDepartures(input)).toEqual([10 * MIN, 20 * MIN]);
    expect(input[0]).toBe(t0 + 30 * MIN_MS);
  });
  it("fewer than two departures → no headways", () => {
    expect(headwaysFromDepartures([])).toEqual([]);
    expect(headwaysFromDepartures([t0])).toEqual([]);
  });
  it("feeds averageWait end to end", () => {
    expect(averageWait(headwaysFromDepartures([t0, t0 + 10 * MIN_MS, t0 + 40 * MIN_MS]))).toBe(12.5 * MIN);
  });
});
