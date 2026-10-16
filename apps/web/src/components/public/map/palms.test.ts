import { describe, expect, it } from "vitest";
import { MAX_PALMS, palmSites } from "./palms";

type P = { lat: number; lng: number };
const m = (a: P, b: P) => {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLng = (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};
/** metres from p to the nearest point of the polyline */
const toLine = (p: P, pts: P[]) => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as P;
    const b = pts[i] as P;
    const ab = m(a, b);
    for (let t = 0; t <= 1; t += 1 / Math.max(1, Math.ceil(ab / 2)))
      best = Math.min(best, m(p, { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }));
  }
  return best;
};

// a straight 2 km road north with a bend, like Mandrem's
const road: P[] = [];
for (let i = 0; i <= 40; i++) road.push({ lat: 15.65 + i * 0.00045, lng: 73.716 + (i > 20 ? (i - 20) * 0.0002 : 0) });
const routes = [{ id: "r", path: road }];
const start = road[0] as P;
const end = road[40] as P;
const spots = [
  { id: "a", lat: start.lat, lng: start.lng },
  { id: "b", lat: end.lat, lng: end.lng },
];

describe("palmSites: low-poly palms along the route corridor", () => {
  const sites = palmSites(routes, spots);

  it("is deterministic and bounded", () => {
    expect(palmSites(routes, spots)).toEqual(sites);
    expect(sites.length).toBeGreaterThan(40);
    expect(sites.length).toBeLessThanOrEqual(MAX_PALMS);
  });

  it("stands beside the road, never on it, and clear of the stops", () => {
    for (const s of sites) {
      const d = toLine(s, road);
      expect(d).toBeGreaterThanOrEqual(8);
      expect(d).toBeLessThanOrEqual(30);
      for (const sp of spots) expect(m(s, sp)).toBeGreaterThanOrEqual(35);
    }
  });

  it("uses both sides of the road and varies the trees", () => {
    const heights = new Set(sites.map((s) => s.height.toFixed(2)));
    expect(heights.size).toBeGreaterThan(5);
    for (const s of sites) {
      expect(s.height).toBeGreaterThanOrEqual(5);
      expect(s.height).toBeLessThanOrEqual(11);
      expect(s.yaw).toBeGreaterThanOrEqual(0);
      expect(s.yaw).toBeLessThan(2 * Math.PI);
    }
    // the first road segment runs north: east of it is +lng
    const north = sites.filter((s) => s.lat < 15.659);
    expect(north.some((s) => s.lng > 73.716)).toBe(true);
    expect(north.some((s) => s.lng < 73.716)).toBe(true);
  });

  it("caps a long network at MAX_PALMS, spread over it rather than cut off", () => {
    const many = Array.from({ length: 12 }, (_, k) => ({
      id: `r${k}`,
      path: road.map((p) => ({ lat: p.lat, lng: p.lng + k * 0.01 })),
    }));
    const all = palmSites(many, []);
    expect(all.length).toBeLessThanOrEqual(MAX_PALMS);
    expect(all.some((s) => s.lng > 73.8)).toBe(true);
  });

  it("ignores degenerate routes", () => {
    expect(palmSites([{ id: "x", path: [start] }], [])).toEqual([]);
    expect(palmSites([], [])).toEqual([]);
  });
});
