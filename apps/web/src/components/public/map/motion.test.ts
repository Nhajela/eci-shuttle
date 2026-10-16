import { describe, expect, it } from "vitest";
import { lerpAngle, retarget, sample, type Track } from "./motion";

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
