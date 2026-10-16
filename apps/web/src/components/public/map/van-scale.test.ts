import { describe, expect, it } from "vitest";
import { metersPerPx, treeScreenScale, VAN_LENGTH_M, vanLabelOffsetPx, vanScreenPx, vanScreenScale } from "./van-scale";

const LAT = 15.66; // Mandrem

describe("metersPerPx", () => {
  it("is the web-mercator ground resolution (512 px tiles)", () => {
    expect(metersPerPx(0, 0)).toBeCloseTo((2 * Math.PI * 6378137) / 512, 3);
    expect(metersPerPx(16, 0)).toBeCloseTo((2 * Math.PI * 6378137) / 512 / 2 ** 16, 6);
    expect(metersPerPx(16, 60)).toBeCloseTo(metersPerPx(16, 0) * 0.5, 6);
  });
});

describe("vanScreenPx: how long the van reads on screen", () => {
  it("grows with every zoom step and never shrinks to a speck when zoomed out", () => {
    let last = 0;
    for (let z = 10; z <= 22; z += 0.25) {
      const px = vanScreenPx(z);
      expect(px).toBeGreaterThanOrEqual(last);
      expect(px).toBeGreaterThanOrEqual(36);
      last = px;
    }
  });

  it("hits the anchors: findable at the overview, roomy up close", () => {
    expect(vanScreenPx(14)).toBeCloseTo(40, 6);
    expect(vanScreenPx(16)).toBeCloseTo(60, 6);
    expect(vanScreenPx(18)).toBeCloseTo(96, 6);
    expect(vanScreenPx(20)).toBeCloseTo(130, 6);
  });

  it("is smooth: geometric between anchors, flat beyond them", () => {
    expect(vanScreenPx(15)).toBeCloseTo(Math.sqrt(40 * 60), 6);
    expect(vanScreenPx(17)).toBeCloseTo(Math.sqrt(60 * 96), 6);
    expect(vanScreenPx(11)).toBe(vanScreenPx(13));
    expect(vanScreenPx(21)).toBe(vanScreenPx(20));
  });
});

describe("vanScreenScale: model metres → the exaggeration that gives that on-screen length", () => {
  it("is an exaggeration (≥ 1) that shrinks as you zoom in, converging on life size", () => {
    let last = Number.POSITIVE_INFINITY;
    for (let z = 11; z <= 22; z += 0.5) {
      const s = vanScreenScale(z, LAT);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(last);
      last = s;
    }
    expect(vanScreenScale(22, LAT)).toBe(1);
  });

  it("gives exactly the wanted screen length while exaggerating", () => {
    for (const z of [14, 16, 18]) {
      const lengthPx = (VAN_LENGTH_M * vanScreenScale(z, LAT)) / metersPerPx(z, LAT);
      expect(lengthPx).toBeCloseTo(vanScreenPx(z), 6);
    }
  });

  it("never goes below life size: a tiny screen length still draws the real van", () => {
    expect(vanScreenScale(22, LAT)).toBe(1);
    expect(vanScreenScale(20.9, 0)).toBe(1);
  });
});

describe("vanLabelOffsetPx: the name sits just above the roof", () => {
  it("rises with the van", () => {
    expect(vanLabelOffsetPx(40)).toBeLessThan(vanLabelOffsetPx(96));
    expect(vanLabelOffsetPx(60)).toBeGreaterThanOrEqual(30);
    expect(Number.isInteger(vanLabelOffsetPx(57.3))).toBe(true);
  });
});

describe("treeScreenScale: the palms are exaggerated too, but less, so the van still towers over nothing", () => {
  it("sits between life size and the van's exaggeration, and shrinks to 1 when zoomed right in", () => {
    let last = Number.POSITIVE_INFINITY;
    for (let z = 11; z <= 22; z += 0.5) {
      const s = treeScreenScale(z, LAT);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(vanScreenScale(z, LAT));
      expect(s).toBeLessThanOrEqual(last);
      last = s;
    }
    expect(treeScreenScale(22, LAT)).toBe(1);
    expect(treeScreenScale(16, LAT)).toBeCloseTo(Math.sqrt(vanScreenScale(16, LAT)), 6);
  });
});
