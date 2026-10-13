import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fitPoints, MapList } from "./admin-map-list";

const riva = { id: "s1", name: "Riva", lat: 15.66, lng: 73.71, radiusM: 60 };
const van = { id: "v1", name: "Van 1", colour: "#e39a2e", lat: 15.67, lng: 73.72, problem: true };

describe("fitPoints", () => {
  it("fits to spots and paths, not to moving markers", () => {
    expect(fitPoints([riva], [[{ lat: 15.6, lng: 73.7 }]], [van])).toEqual([
      [15.66, 73.71],
      [15.6, 73.7],
    ]);
  });
  it("falls back to markers when there are no spots or paths", () => {
    expect(fitPoints([], [], [van])).toEqual([[15.67, 73.72]]);
  });
  it("is empty when there is nothing to show", () => {
    expect(fitPoints([], [], [])).toEqual([]);
  });
});

describe("MapList (shown when the map can't load)", () => {
  it("lists markers first, flags problems, then spots", () => {
    const html = renderToString(createElement(MapList, { spots: [riva], markers: [van] }));
    expect(html).toContain("Van 1");
    expect(html).toContain("needs attention");
    expect(html).toContain("Riva");
    expect(html.indexOf("Van 1")).toBeLessThan(html.indexOf("Riva"));
    expect(html).toContain("google.com/maps/search/?api=1&amp;query=15.67,73.72");
  });
  it("says so when there is nothing", () => {
    expect(renderToString(createElement(MapList, { spots: [], markers: [] }))).toContain("Nothing to show");
  });
});
