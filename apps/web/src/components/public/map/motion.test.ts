import { describe, expect, it } from "vitest";
import { lerpAngle, pointAt, retarget, routePath, sample, type Track } from "./motion";

describe("lerpAngle", () => {
  it("turns the short way round", () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0);
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0);
    expect(lerpAngle(0, 180, 0.25)).toBeCloseTo(45);
    expect(lerpAngle(90, 90, 0.7)).toBeCloseTo(90);
  });
});

describe("retarget / sample: a marker glides from where it is to the newest fix", () => {
  const fix1 = { lat: 15.66, lng: 73.717, headingDeg: 20 };
  const fix2 = { lat: 15.661, lng: 73.7175, headingDeg: 30 };

  it("a first fix is placed at once", () => {
    const t = retarget(undefined, fix1, 1000, 5000);
    expect(sample(t, 1000)).toEqual(fix1);
    expect(sample(t, 9000)).toEqual(fix1);
  });

  it("a new fix starts a glide from the current rendered position over the given duration", () => {
    const t1 = retarget(undefined, fix1, 1000, 5000);
    const t2 = retarget(t1, fix2, 2000, 4000);
    expect(sample(t2, 2000)).toEqual(fix1);
    const mid = sample(t2, 4000);
    expect(mid.lat).toBeCloseTo((fix1.lat + fix2.lat) / 2, 6);
    expect(mid.lng).toBeCloseTo((fix1.lng + fix2.lng) / 2, 6);
    expect(mid.headingDeg).toBeCloseTo(25, 5);
    expect(sample(t2, 6000)).toEqual(fix2);
    expect(sample(t2, 60_000)).toEqual(fix2);
  });

  it("a fix arriving mid-glide starts from the in-between spot, never jumps back", () => {
    const t1 = retarget(undefined, fix1, 0, 1000);
    const t2 = retarget(t1, fix2, 0, 4000);
    const half = sample(t2, 2000);
    const t3 = retarget(t2, fix1, 2000, 4000);
    expect(sample(t3, 2000)).toEqual(half);
  });

  it("an identical fix keeps the heading it had, so a parked van does not twitch", () => {
    const t1 = retarget(undefined, fix1, 0, 1000);
    const t2 = retarget(t1, { ...fix1, headingDeg: null }, 5000, 4000);
    expect(sample(t2, 9000).headingDeg).toBe(20);
  });

  it("a fix without a heading takes its heading from the direction it moved", () => {
    const t1 = retarget(undefined, { ...fix1, headingDeg: null }, 0, 1000);
    const north = { lat: 15.67, lng: 73.717, headingDeg: null };
    const t2 = retarget(t1, north, 5000, 1000);
    expect(sample(t2, 9000).headingDeg).toBeCloseTo(0, 0);
    const t: Track = t2;
    expect(t.to.headingDeg).toBeCloseTo(0, 0);
  });
});

describe("along the road: a van on its route glides along the route path, not in a straight line", () => {
  // an L-shaped road: 0 → 100 m north, then 100 m east (≈ metres at Mandrem's latitude)
  const lat0 = 15.66;
  const lng0 = 73.71;
  const north = 100 / 111_320;
  const east = 100 / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const road = routePath([
    { lat: lat0, lng: lng0 },
    { lat: lat0 + north, lng: lng0 },
    { lat: lat0 + north, lng: lng0 + east },
  ]);
  const at = (alongM: number) => ({ ...pointAt(road, alongM), alongM });

  it("measures the path and finds points and headings along it", () => {
    expect(road.lengthM).toBeCloseTo(200, 0);
    expect(pointAt(road, 50).lat).toBeCloseTo(lat0 + north / 2, 6);
    expect(pointAt(road, 50).headingDeg).toBeCloseTo(0, 0);
    expect(pointAt(road, 150).headingDeg).toBeCloseTo(90, 0);
    expect(pointAt(road, 999).lng).toBeCloseTo(lng0 + east, 6);
  });

  it("rounds the corner: halfway through a glide from 50 m to 150 m it is at the corner, not cutting across", () => {
    const t1 = retarget(undefined, at(50), 0, 4000, road);
    const t2 = retarget(t1, at(150), 1000, 4000, road);
    const mid = sample(t2, 3000);
    expect(mid.lat).toBeCloseTo(lat0 + north, 6);
    expect(mid.lng).toBeCloseTo(lng0, 6);
  });

  it("faces the way the road goes", () => {
    const t1 = retarget(undefined, at(10), 0, 4000, road);
    const t2 = retarget(t1, at(190), 0, 4000, road);
    expect(sample(t2, 500).headingDeg).toBeCloseTo(0, 0);
    expect(sample(t2, 4000).headingDeg).toBeCloseTo(90, 0);
  });

  it("GPS jitter a few metres backwards doesn't make it reverse; a loop wraps forward past the end", () => {
    const loop = routePath([
      { lat: lat0, lng: lng0 },
      { lat: lat0 + north, lng: lng0 },
      { lat: lat0, lng: lng0 },
    ]);
    const on = (alongM: number) => ({ ...pointAt(loop, alongM), alongM });
    const t1 = retarget(undefined, on(120), 0, 4000, loop);
    const jitter = retarget(t1, on(110), 0, 4000, loop);
    expect(sample(jitter, 4000).lat).toBeCloseTo(pointAt(loop, 120).lat, 7);
    // near the end of the loop, the next fix is just past the start: it carries on forwards, through the end
    const t3 = retarget(undefined, on(190), 0, 4000, loop);
    const t4 = retarget(t3, on(10), 0, 4000, loop);
    // halfway it is back at the start (reversing would have taken it up to the far end), still heading home
    expect(sample(t4, 2000).lat).toBeCloseTo(lat0, 5);
    expect(sample(t4, 1000).headingDeg).toBeCloseTo(180, 0);
    expect(sample(t4, 4000).headingDeg).toBeCloseTo(0, 0);
  });

  it("a fix with no road position (off the route) glides straight as before", () => {
    const t1 = retarget(undefined, at(50), 0, 4000, road);
    const off = { lat: lat0 + north, lng: lng0 + east, headingDeg: null, alongM: null };
    const t2 = retarget(t1, off, 0, 4000, road);
    const mid = sample(t2, 2000);
    expect(mid.lng).toBeGreaterThan(lng0);
    expect(mid.lat).toBeLessThan(lat0 + north);
  });
});
