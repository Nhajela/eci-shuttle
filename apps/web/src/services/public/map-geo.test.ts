import { describe, expect, it } from "vitest";
import { bearingDeg, headingAlongPath, legFraction } from "./map-geo";

// a straight north-south line of three points, 0.01° apart (≈ 1.1 km each)
const NORTH = [
  { lat: 15.65, lng: 73.72 },
  { lat: 15.66, lng: 73.72 },
  { lat: 15.67, lng: 73.72 },
];

describe("bearingDeg", () => {
  it("is 0 north, 90 east, 180 south, 270 west", () => {
    const o = { lat: 15.65, lng: 73.72 };
    expect(bearingDeg(o, { lat: 15.66, lng: 73.72 })).toBeCloseTo(0, 0);
    expect(bearingDeg(o, { lat: 15.65, lng: 73.73 })).toBeCloseTo(90, 0);
    expect(bearingDeg(o, { lat: 15.64, lng: 73.72 })).toBeCloseTo(180, 0);
    expect(bearingDeg(o, { lat: 15.65, lng: 73.71 })).toBeCloseTo(270, 0);
  });
});

describe("headingAlongPath", () => {
  it("is the bearing of the segment the vehicle is on", () => {
    const back = [...NORTH].reverse();
    expect(headingAlongPath(NORTH, 500)).toBeCloseTo(0, 0);
    expect(headingAlongPath(NORTH, 1500)).toBeCloseTo(0, 0);
    expect(headingAlongPath(back, 500)).toBeCloseTo(180, 0);
  });

  it("clamps to the first and last segment, and is null for a path with one point or none", () => {
    expect(headingAlongPath(NORTH, -10)).toBeCloseTo(0, 0);
    expect(headingAlongPath(NORTH, 99_999)).toBeCloseTo(0, 0);
    expect(headingAlongPath([], 10)).toBeNull();
    expect(headingAlongPath([NORTH[0] as (typeof NORTH)[number]], 10)).toBeNull();
  });
});

describe("legFraction", () => {
  const route = { path: NORTH, spotPathIdx: [0, 1, 2], spotIds: ["a", "b", "c"] };

  it("is how far along its leg the vehicle is, 0..1", () => {
    const legM = 1112; // ≈ 0.01° of latitude
    expect(legFraction(route, 0, 0)).toBe(0);
    expect(legFraction(route, 0, legM / 2)).toBeCloseTo(0.5, 1);
    expect(legFraction(route, 1, legM * 1.5)).toBeCloseTo(0.5, 1);
    expect(legFraction(route, 1, legM * 3)).toBe(1);
    expect(legFraction(route, 0, -5)).toBe(0);
  });

  it("is null when the route has no usable path or the leg does not exist", () => {
    expect(legFraction({ path: [], spotPathIdx: [], spotIds: ["a", "b"] }, 0, 10)).toBeNull();
    expect(legFraction(route, 5, 10)).toBeNull();
    expect(legFraction(route, 0, null)).toBeNull();
  });
});
