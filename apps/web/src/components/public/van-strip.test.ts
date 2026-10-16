import { describe, expect, it } from "vitest";
import type { PublicMap, PublicVehicle } from "@/services/public/positions";
import { stripLayout } from "./van-strip";

const riva = { id: "riva", name: "Riva Beach Resort", shortName: "Riva", lat: 15.6553, lng: 73.7152 };
const circle = { id: "circle", name: "The Circle", shortName: "Circle", lat: 15.664, lng: 73.7185 };
const beach = { id: "beach", name: "Beach", shortName: "Beach", lat: 15.66, lng: 73.71 };
const loop: PublicMap["routes"][number] = {
  id: "r",
  name: "Riva ⇄ Circle",
  colour: null,
  spotIds: ["riva", "circle", "riva"],
  path: [],
  spotPathIdx: [],
  lengthM: 2000,
};
const van = (over: Partial<PublicVehicle>): PublicVehicle => ({
  id: "v",
  name: "Shuttle 1",
  colour: null,
  lat: 0,
  lng: 0,
  phase: "en_route",
  onBreak: false,
  routeId: "r",
  atSpotId: null,
  nextSpotId: "circle",
  nextSpotName: "Circle",
  legIndex: 0,
  legFraction: 0.25,
  headingDeg: 20,
  alongM: 300,
  since: "2026-10-16T07:00:00.000Z",
  lastSeenS: 5,
  ...over,
});

describe("stripLayout: the little van between the stops", () => {
  it("draws each stop once, spread across the strip, for the route serving the chosen spot", () => {
    const l = stripLayout({ spots: [riva, circle, beach], routes: [loop], vehicles: [] }, "circle");
    expect(l?.stops).toEqual([
      { id: "riva", name: "Riva", x: 0 },
      { id: "circle", name: "Circle", x: 1 },
    ]);
    expect(l?.vans).toEqual([]);
  });

  it("is null when no route serves the spot", () => {
    expect(stripLayout({ spots: [riva, circle, beach], routes: [loop], vehicles: [] }, "beach")).toBeNull();
    expect(stripLayout({ spots: [], routes: [], vehicles: [] }, "riva")).toBeNull();
  });

  it("puts a van a quarter of the way out on the way to Circle, and three quarters back on the return leg", () => {
    const out = stripLayout({ spots: [riva, circle], routes: [loop], vehicles: [van({})] }, "riva");
    expect(out?.vans).toEqual([{ id: "v", name: "Shuttle 1", x: 0.25, dir: 1, onBreak: false, atSpot: null }]);
    const back = stripLayout(
      {
        spots: [riva, circle],
        routes: [loop],
        vehicles: [van({ legIndex: 1, legFraction: 0.25, nextSpotId: "riva" })],
      },
      "riva",
    );
    expect(back?.vans[0]).toMatchObject({ x: 0.75, dir: -1 });
  });

  it("parks a van at its stop, with the stop's name, and shows a chai cup on a break", () => {
    const l = stripLayout(
      {
        spots: [riva, circle],
        routes: [loop],
        vehicles: [van({ phase: "at_spot", atSpotId: "circle", legIndex: null, legFraction: null, onBreak: true })],
      },
      "riva",
    );
    expect(l?.vans[0]).toMatchObject({ x: 1, atSpot: "Circle", onBreak: true });
  });

  it("leaves out a van on another route, or one whose place on the route is unknown", () => {
    const other = van({ routeId: "other" });
    const lost = van({ legIndex: null, legFraction: null, atSpotId: null });
    expect(stripLayout({ spots: [riva, circle], routes: [loop], vehicles: [other, lost] }, "riva")?.vans).toEqual([]);
  });
});
