import { distanceM, pathLengthM } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import type { DeadZone } from "../signal/dead-zones";
import { pointAtAlong, predictRoute, spotAlongM } from "./predict";

const A = "a";
const B = "b";
const C = "c";
// a straight path north, ~111 m per 0.001° of latitude
const path = [0, 0.001, 0.002, 0.003, 0.004].map((lat) => ({ lat, lng: 73 }));
const route = {
  id: "r1",
  spotIds: [A, B, C],
  spotPathIdx: [0, 2, 4],
  path,
  typicalLegS: [null, 240] as (number | null)[],
};
const zone: DeadZone = {
  routeId: "r1",
  legIndex: 1,
  fromSpotId: B,
  toSpotId: C,
  startAlongM: null,
  endAlongM: null,
  source: "manual",
  typicalLegS: null,
};

describe("spotAlongM", () => {
  it("is the metres along the path of each spot", () => {
    const m = spotAlongM(route) as number[];
    expect(m).toHaveLength(3);
    expect(m[0]).toBe(0);
    expect(m[1]).toBeCloseTo(pathLengthM(path.slice(0, 3)), 3);
    expect(m[2]).toBeCloseTo(pathLengthM(path), 3);
  });
  it("is null when the path is not indexed to the spots", () => {
    expect(spotAlongM({ ...route, spotPathIdx: [0, 2] })).toBeNull();
    expect(spotAlongM({ ...route, path: [] })).toBeNull();
  });
});

describe("predictRoute", () => {
  it("null when the route has no dead zone (nothing to predict)", () => {
    expect(predictRoute(route, [], [])).toBeNull();
    expect(predictRoute(route, [{ ...zone, routeId: "other" }], [])).toBeNull();
  });
  it("carries the route's zones and its distances; the leg time falls back to the route's typical time, then the baseline", () => {
    const p = predictRoute(route, [zone, { ...zone, routeId: "other" }], [100, null]);
    expect(p?.routeId).toBe("r1");
    expect(p?.zones).toEqual([zone]);
    expect(p?.spotIds).toEqual([A, B, C]);
    // given estimates win; a missing one uses the route's learned typical time; neither → null
    expect(p?.legS).toEqual([100, 240]);
    expect(predictRoute(route, [zone], [])?.legS).toEqual([null, 240]);
  });
});

describe("pointAtAlong", () => {
  it("interpolates on the path", () => {
    const total = pathLengthM(path);
    expect(pointAtAlong(path, 0)).toEqual(path[0]);
    expect(pointAtAlong(path, total)).toEqual(path[4]);
    const mid = pointAtAlong(path, total / 2) as { lat: number; lng: number };
    expect(mid.lat).toBeCloseTo(0.002, 6);
    const q = pointAtAlong(path, 150) as { lat: number; lng: number };
    expect(distanceM(path[0] as { lat: number; lng: number }, q)).toBeCloseTo(150, 0);
  });
  it("clamps outside the path, and null for a path without a length", () => {
    expect(pointAtAlong(path, -50)).toEqual(path[0]);
    expect(pointAtAlong(path, 1e9)).toEqual(path[4]);
    expect(pointAtAlong([], 10)).toBeNull();
    expect(pointAtAlong([path[0] as { lat: number; lng: number }], 10)).toEqual(path[0]);
  });
});
