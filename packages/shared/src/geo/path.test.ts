import { describe, expect, it } from "vitest";
import { distanceM, pathLengthM, projectOntoPath } from "./path";

// Mandrem-scale points: a straight east-going road at lat 15.65.
const A = { lat: 15.65, lng: 73.71 };
const B = { lat: 15.65, lng: 73.72 };
const C = { lat: 15.65, lng: 73.73 };
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180; // ≈ 111 195 m

describe("distanceM", () => {
  it("same point → 0", () => {
    expect(distanceM(A, A)).toBe(0);
  });
  it("matches known great-circle distances (within 0.5%)", () => {
    expect(distanceM(A, { lat: 15.66, lng: 73.71 })).toBeCloseTo(0.01 * M_PER_DEG_LAT, 0);
    // 0.01° of longitude shrinks by cos(lat)
    expect(distanceM(A, B)).toBeCloseTo(0.01 * M_PER_DEG_LAT * Math.cos((15.65 * Math.PI) / 180), 0);
    // London → Paris ≈ 343.5 km
    const d = distanceM({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
    expect(Math.abs(d - 343_500) / 343_500).toBeLessThan(0.005);
  });
});

describe("pathLengthM", () => {
  it("sum of segment lengths; one point → 0", () => {
    expect(pathLengthM([A, B, C])).toBeCloseTo(distanceM(A, B) + distanceM(B, C), 6);
    expect(pathLengthM([A])).toBe(0);
    expect(pathLengthM([])).toBe(0);
  });
});

describe("projectOntoPath", () => {
  const path = [A, B, C];

  it("point on the path → offsetM ≈ 0, alongM = distance from start", () => {
    const p = { lat: 15.65, lng: 73.725 };
    const r = projectOntoPath(path, p);
    expect(r.offsetM).toBeLessThan(0.5);
    expect(r.alongM).toBeCloseTo(distanceM(A, p), 0);
    expect(r.segmentIndex).toBe(1);
    expect(r.totalM).toBeCloseTo(pathLengthM(path), 6);
  });

  it("point beside a segment → perpendicular foot, offsetM = perpendicular distance", () => {
    const r = projectOntoPath(path, { lat: 15.651, lng: 73.715 });
    expect(r.segmentIndex).toBe(0);
    expect(r.offsetM).toBeCloseTo(0.001 * M_PER_DEG_LAT, 0);
    expect(r.alongM).toBeCloseTo(distanceM(A, B) / 2, 0);
    expect(r.point.lat).toBeCloseTo(15.65, 6);
    expect(r.point.lng).toBeCloseTo(73.715, 6);
  });

  it("point before the start clamps to alongM 0", () => {
    const p = { lat: 15.65, lng: 73.7 };
    const r = projectOntoPath(path, p);
    expect(r.alongM).toBe(0);
    expect(r.segmentIndex).toBe(0);
    expect(r.point).toEqual(A);
    expect(r.offsetM).toBeCloseTo(distanceM(A, p), 6);
  });

  it("point past the end clamps to alongM = totalM", () => {
    const r = projectOntoPath(path, { lat: 15.65, lng: 73.74 });
    expect(r.alongM).toBeCloseTo(r.totalM, 6);
    expect(r.segmentIndex).toBe(1);
    expect(r.point).toEqual(C);
  });

  it("picks the nearest segment, ties go to the earlier segment (loop paths)", () => {
    // out and back along the same road: both passes are equally near
    const loop = [A, B, A];
    const r = projectOntoPath(loop, { lat: 15.6505, lng: 73.715 });
    expect(r.segmentIndex).toBe(0);
    expect(r.alongM).toBeCloseTo(distanceM(A, B) / 2, 0);
    // an L-shaped path: a point near the second leg goes to segment 1
    const ell = [A, B, { lat: 15.66, lng: 73.72 }];
    const s = projectOntoPath(ell, { lat: 15.655, lng: 73.7201 });
    expect(s.segmentIndex).toBe(1);
    expect(s.alongM).toBeCloseTo(distanceM(A, B) + 0.005 * M_PER_DEG_LAT, 0);
  });

  it("repeated points (zero-length segments) don't divide by zero", () => {
    const r = projectOntoPath([A, A, B, B], { lat: 15.65, lng: 73.715 });
    expect(Number.isFinite(r.alongM)).toBe(true);
    expect(r.segmentIndex).toBe(1);
    expect(r.offsetM).toBeLessThan(0.5);
    const degenerate = projectOntoPath([A, A], B);
    expect(degenerate).toEqual({ alongM: 0, offsetM: distanceM(A, B), segmentIndex: 0, totalM: 0, point: A });
  });

  it("single-point path → alongM 0, totalM 0", () => {
    const r = projectOntoPath([A], B);
    expect(r).toEqual({ alongM: 0, offsetM: distanceM(A, B), segmentIndex: 0, totalM: 0, point: A });
  });

  it("empty path throws", () => {
    expect(() => projectOntoPath([], A)).toThrow();
  });
});
