import { describe, expect, it } from "vitest";
import type { LatLng } from "../contracts";
import { legOf, spotAlongM, spotCandidates, spotIndexOf } from "./legOf";
import { pathLengthM } from "./path";

// The live route: out-and-back along one road (north), Nanu is both ends of the loop.
const at = (km: number): LatLng => ({ lat: 15.6 + km * 0.009, lng: 73.7 });
const KM = [0, 1, 2, 3, 2, 1, 0];
const ids = ["nanu", "riva", "circle", "namaka", "circle", "riva", "nanu"];
const outAndBack = { spotIds: ids, spotPathIdx: [0, 1, 2, 3, 4, 5, 6], path: KM.map(at) };
const cum = outAndBack.path.map((_, i) => pathLengthM(outAndBack.path.slice(0, i + 1)));

// A route that never repeats a stop: Riva → Circle → Namaka.
const oneWay = { spotIds: ["riva", "circle", "namaka"], spotPathIdx: [0, 1, 2], path: [0, 1, 2].map(at) };

describe("spotAlongM", () => {
  it("metres along the route of every spot occurrence", () => {
    const m = spotAlongM(outAndBack) as number[];
    expect(m).toHaveLength(7);
    expect(m[3]).toBeCloseTo(cum[3] as number, 3);
    expect(m[6]).toBeCloseTo(cum[6] as number, 3);
  });
  it("null when the geometry does not line up with the spots", () => {
    expect(spotAlongM({ spotIds: ids, spotPathIdx: [0], path: outAndBack.path })).toBeNull();
    expect(spotAlongM({ spotIds: ids })).toBeNull();
  });
});

describe("legOf on an out-and-back route", () => {
  it("(spot, next) names the leg: the same spot twice resolves by where it goes next", () => {
    expect(legOf(outAndBack, { spotId: "circle", nextSpotId: "namaka" })).toBe(2);
    expect(legOf(outAndBack, { spotId: "circle", nextSpotId: "riva" })).toBe(4);
    expect(legOf(outAndBack, { spotId: "riva", nextSpotId: "circle" })).toBe(1);
    expect(legOf(outAndBack, { spotId: "riva", nextSpotId: "nanu" })).toBe(5);
    expect(legOf(outAndBack, { spotId: "namaka", nextSpotId: "circle" })).toBe(3);
  });
  it("the reported symptom: just left Namaka, next Circle is leg 3, not Riva → Circle (leg 1)", () => {
    expect(legOf(outAndBack, { spotId: "namaka", nextSpotId: "circle", alongM: cum[3] + 50 })).toBe(3);
    expect(legOf(outAndBack, { nextSpotId: "circle", alongM: cum[3] + 50 })).toBe(3);
  });
  it("next spot alone is ambiguous: alongM picks the leg whose span holds it, both directions", () => {
    expect(legOf(outAndBack, { nextSpotId: "circle", alongM: cum[1] + 300 })).toBe(1);
    expect(legOf(outAndBack, { nextSpotId: "circle", alongM: cum[3] + 300 })).toBe(3);
    expect(legOf(outAndBack, { nextSpotId: "riva", alongM: cum[0] + 300 })).toBe(0);
    expect(legOf(outAndBack, { nextSpotId: "riva", alongM: cum[4] + 300 })).toBe(4);
  });
  it("alongM alone: the leg containing it", () => {
    expect(legOf(outAndBack, { alongM: cum[2] + 10 })).toBe(2);
    expect(legOf(outAndBack, { alongM: cum[5] + 10 })).toBe(5);
  });
  it("without alongM the first occurrence is the fallback", () => {
    expect(legOf(outAndBack, { nextSpotId: "circle" })).toBe(1);
    expect(legOf(outAndBack, {})).toBe(0);
  });
  it("a spot that is not on the route → -1; a route with no legs → -1", () => {
    expect(legOf(outAndBack, { nextSpotId: "mars" })).toBe(-1);
    expect(legOf(outAndBack, { spotId: "mars", nextSpotId: "mars" })).toBe(-1);
    expect(legOf({ spotIds: ["riva"] }, {})).toBe(-1);
  });
  it("an inconsistent pair falls back to the next spot (what the vehicle is heading for)", () => {
    expect(legOf(outAndBack, { spotId: "namaka", nextSpotId: "riva", alongM: cum[4] + 10 })).toBe(4);
  });
});

describe("legOf on a loop wrap (Nanu is the first and the last spot)", () => {
  it("leaving the start and leaving the end of the lap both head to Riva: leg 0", () => {
    expect(legOf(outAndBack, { spotId: "nanu", nextSpotId: "riva" })).toBe(0);
    expect(legOf(outAndBack, { spotId: "nanu", nextSpotId: "riva", alongM: 5 })).toBe(0);
  });
  it("heading for Nanu on the way back is the last leg", () => {
    expect(legOf(outAndBack, { spotId: "riva", nextSpotId: "nanu" })).toBe(5);
    expect(legOf(outAndBack, { nextSpotId: "nanu" })).toBe(5);
  });
});

describe("legOf on a route that never repeats a stop (unchanged)", () => {
  it("matches indexOf", () => {
    expect(legOf(oneWay, { spotId: "riva", nextSpotId: "circle" })).toBe(0);
    expect(legOf(oneWay, { nextSpotId: "namaka" })).toBe(1);
    expect(legOf(oneWay, { nextSpotId: "circle", alongM: 99_999 })).toBe(0);
    expect(legOf(oneWay, { nextSpotId: "riva" })).toBe(-1);
  });
});

describe("spotIndexOf", () => {
  it("a spot that appears once", () => {
    expect(spotIndexOf(outAndBack, "namaka")).toBe(3);
    expect(spotIndexOf(oneWay, "circle")).toBe(1);
  });
  it("an at_spot vehicle: the next spot picks the occurrence", () => {
    expect(spotIndexOf(outAndBack, "circle", { nextSpotId: "namaka" })).toBe(2);
    expect(spotIndexOf(outAndBack, "circle", { nextSpotId: "riva" })).toBe(4);
    expect(spotIndexOf(outAndBack, "riva", { nextSpotId: "nanu" })).toBe(5);
  });
  it("alongM picks the occurrence nearest to it", () => {
    expect(spotIndexOf(outAndBack, "circle", { alongM: cum[2] + 40 })).toBe(2);
    expect(spotIndexOf(outAndBack, "circle", { alongM: cum[4] - 40 })).toBe(4);
  });
  it("the last spot of a one-way route has no next spot", () => {
    expect(spotIndexOf(oneWay, "namaka", { nextSpotId: null })).toBe(2);
  });
  it("first occurrence when nothing disambiguates; -1 when off the route", () => {
    expect(spotIndexOf(outAndBack, "circle")).toBe(2);
    expect(spotIndexOf(outAndBack, "mars")).toBe(-1);
  });
});

describe("spotCandidates with the recent visit history", () => {
  it("the stops visited just before pick the occurrence", () => {
    // outbound: Nanu, Riva, Circle  → index 2
    expect(spotCandidates(outAndBack, "circle", { recent: ["nanu", "riva", "circle"] })).toEqual([2]);
    // return: ... Namaka, Circle → index 4
    expect(spotCandidates(outAndBack, "circle", { recent: ["riva", "circle", "namaka", "circle"] })).toEqual([4]);
    expect(spotCandidates(outAndBack, "riva", { recent: ["namaka", "circle", "riva"] })).toEqual([5]);
  });
  it("a loop wraps: the second lap matches like the first", () => {
    const lap2 = ["nanu", "riva", "circle", "namaka", "circle", "riva", "nanu", "riva", "circle"];
    expect(spotCandidates(outAndBack, "circle", { recent: lap2 })).toEqual([2]);
  });
  it("only one stop of history is still ambiguous: both occurrences stay", () => {
    expect(spotCandidates(outAndBack, "circle", { recent: ["circle"] })).toEqual([2, 4]);
  });
  it("history that does not end at the spot is ignored", () => {
    expect(spotCandidates(outAndBack, "circle", { recent: ["namaka"] })).toEqual([2, 4]);
  });
});
