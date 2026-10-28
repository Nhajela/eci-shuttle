import { describe, expect, it } from "vitest";
import { formatLeg, insertVertex, legRows, moveItem, parsePath, parseWaits, removeVertex, spotChain } from "./routes";

const names = { a: "Riva", b: "Circle" };

describe("formatLeg", () => {
  it("says when a leg has no learned time", () => {
    expect(formatLeg(null)).toBe("not learned yet");
    expect(formatLeg(undefined)).toBe("not learned yet");
  });
  it("rounds to whole minutes, with a floor of under a minute", () => {
    expect(formatLeg(45)).toBe("under 1 min");
    expect(formatLeg(89)).toBe("1 min");
    expect(formatLeg(12 * 60 + 40)).toBe("13 min");
  });
});

describe("legRows", () => {
  it("pairs consecutive spots with their learned time", () => {
    expect(legRows({ spotIds: ["a", "b", "a"], typicalLegS: [600, null] }, names)).toEqual([
      { from: "Riva", to: "Circle", time: "10 min", learned: true, noSignal: null },
      { from: "Circle", to: "Riva", time: "not learned yet", learned: false, noSignal: null },
    ]);
  });
  it("says how many trips a learned leg comes from", () => {
    expect(legRows({ spotIds: ["a", "b", "a"], typicalLegS: [600, null], legSamples: [24, 0] }, names)).toEqual([
      { from: "Riva", to: "Circle", time: "10 min (24 trips)", learned: true, noSignal: null },
      { from: "Circle", to: "Riva", time: "not learned yet", learned: false, noSignal: null },
    ]);
  });
  it("treats a missing typical_leg_s entry as unknown and names a spot it can't find", () => {
    expect(legRows({ spotIds: ["a", "zz"], typicalLegS: [] }, names)).toEqual([
      { from: "Riva", to: "Unknown spot", time: "not learned yet", learned: false, noSignal: null },
    ]);
  });
});

describe("legRows no-signal marks", () => {
  it("shows manual over detected, detected alone, and none", () => {
    const rows = legRows(
      {
        spotIds: ["a", "b", "a", "b"],
        typicalLegS: [],
        noSignalLegs: [
          { legIndex: 0, source: "detected" },
          { legIndex: 0, source: "manual" },
          { legIndex: 1, source: "detected" },
        ],
      },
      names,
    );
    expect(rows.map((r) => r.noSignal)).toEqual(["manual", "detected", null]);
  });
  it("shows an admin's 'has signal' mark over a detected stretch", () => {
    const rows = legRows(
      {
        spotIds: ["a", "b", "a"],
        typicalLegS: [],
        noSignalLegs: [
          { legIndex: 0, source: "detected" },
          { legIndex: 0, source: "manual", noSignal: false },
        ],
      },
      names,
    );
    expect(rows.map((r) => r.noSignal)).toEqual(["cleared", null]);
  });
});

describe("spotChain", () => {
  it("joins spot names in order", () => {
    expect(spotChain(["a", "b", "a"], names)).toBe("Riva → Circle → Riva");
  });
});

describe("moveItem", () => {
  it("swaps with the neighbour and leaves the input alone", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(list, 2, -1)).toEqual(["a", "c", "b"]);
    expect(list).toEqual(["a", "b", "c"]);
  });
  it("ignores moves past either end", () => {
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("removeVertex", () => {
  it("drops one point but never below two", () => {
    const p = [
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
      { lat: 3, lng: 3 },
    ];
    expect(removeVertex(p, 1)).toEqual([p[0], p[2]]);
    expect(removeVertex([p[0], p[1]], 0)).toEqual([p[0], p[1]]);
  });
});

describe("insertVertex", () => {
  const p = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 10 },
    { lat: 10, lng: 10 },
  ];
  it("puts the new point into the nearest segment", () => {
    expect(insertVertex(p, { lat: 1, lng: 5 })).toEqual([p[0], { lat: 1, lng: 5 }, p[1], p[2]]);
    expect(insertVertex(p, { lat: 5, lng: 11 })).toEqual([p[0], p[1], { lat: 5, lng: 11 }, p[2]]);
  });
  it("uses the end segment for a point beyond the line", () => {
    expect(insertVertex(p, { lat: 0, lng: -3 })).toEqual([p[0], { lat: 0, lng: -3 }, p[1], p[2]]);
  });
});

describe("parsePath", () => {
  it("reads a JSON list of points", () => {
    expect(parsePath('[{"lat":15.6,"lng":73.7},{"lat":15.61,"lng":73.71}]')).toEqual([
      { lat: 15.6, lng: 73.7 },
      { lat: 15.61, lng: 73.71 },
    ]);
  });
  it("returns null for anything else", () => {
    expect(parsePath(null)).toBeNull();
    expect(parsePath("not json")).toBeNull();
    expect(parsePath('{"lat":1}')).toBeNull();
    expect(parsePath('[{"lat":"x","lng":1}]')).toBeNull();
  });
});

describe("parseWaits", () => {
  const fd = (entries: [string, string][]) => {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  };
  it("turns the minutes fields into planned_dwell_s seconds: '*' for every stop, a spot id for one", () => {
    expect(
      parseWaits(
        fd([
          ["waitMin", "5"],
          ["waitMin:b", "1.5"],
          ["waitMin:a", "0"],
          ["waitMin:c", " "],
        ]),
      ),
    ).toEqual({ "*": 300, b: 90, a: 0 });
  });
  it("blank everywhere clears the plan; a form without the fields leaves it alone", () => {
    expect(parseWaits(fd([["waitMin", ""]]))).toEqual({});
    expect(parseWaits(fd([["name", "x"]]))).toBeUndefined();
  });
});
