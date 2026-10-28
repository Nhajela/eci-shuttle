import { describe, expect, it } from "vitest";
import {
  type MapVehicle,
  estimatedCount,
  isEstimated,
  mapAriaLabel,
  summaryCopy,
  vanLabelText,
} from "./estimate";

const v = (over: Partial<MapVehicle> = {}): MapVehicle => ({
  id: "v1",
  name: "Shuttle 1",
  colour: null,
  lat: 15.66,
  lng: 73.71,
  phase: "en_route",
  onBreak: false,
  routeId: "r",
  atSpotId: null,
  nextSpotId: null,
  nextSpotName: null,
  legIndex: 0,
  legFraction: 0.5,
  headingDeg: 90,
  alongM: 100,
  since: "2026-10-28T05:00:00.000Z",
  lastSeenS: 30,
  ...over,
});
const est = (over: Partial<MapVehicle> = {}) =>
  v({ estimate: { reason: "no_signal", lastSeenAt: "2026-10-28T05:00:00.000Z" }, ...over });

describe("isEstimated", () => {
  it("is false without the field (older server) and true with it", () => {
    expect(isEstimated(v())).toBe(false);
    expect(isEstimated(est())).toBe(true);
  });
});

describe("summaryCopy", () => {
  it("keeps the old copy when nothing is estimated", () => {
    expect(summaryCopy([])).toBe("No shuttle in sight right now");
    expect(summaryCopy([v()])).toBe("1 shuttle on the road");
    expect(summaryCopy([v(), v({ id: "b" })])).toBe("2 shuttles on the road");
  });
  it("counts estimated vans as on the road and says so", () => {
    expect(summaryCopy([v(), est({ id: "b" })])).toBe("2 shuttles on the road · 1 estimated (no signal)");
    expect(summaryCopy([est()])).toBe("1 shuttle on the road · estimated (no signal)");
    expect(summaryCopy([est(), est({ id: "b" })])).toBe("2 shuttles on the road · all estimated (no signal)");
  });
  it("never mentions lateness", () => {
    expect(summaryCopy([est()]).toLowerCase()).not.toMatch(/late|delay|behind/);
  });
  it("counts", () => {
    expect(estimatedCount([v(), est()])).toBe(1);
  });
});

describe("vanLabelText", () => {
  it("is the name for a live van", () => {
    expect(vanLabelText(v())).toBe("Shuttle 1");
    expect(vanLabelText(v({ onBreak: true }))).toBe("☕ Shuttle 1 · on a break");
  });
  it("adds the no-signal tag for an estimate", () => {
    expect(vanLabelText(est())).toBe("Shuttle 1 · no signal · estimated");
    expect(vanLabelText(est({ onBreak: true }))).toBe("☕ Shuttle 1 · on a break · no signal · estimated");
  });
});

describe("mapAriaLabel", () => {
  it("is the plain label when all are live", () => {
    expect(mapAriaLabel([v()])).toBe("Live map of the shuttle");
  });
  it("names estimated vans", () => {
    expect(mapAriaLabel([v(), est({ name: "Shuttle 2" })])).toBe(
      "Live map of the shuttle. Shuttle 2: estimated position, no signal.",
    );
  });
});
