import { describe, expect, it } from "vitest";
import { MAP_PIN_MAX_AGE_MS, mapPin } from "./mapPin";

const NOW = Date.parse("2026-10-13T06:00:00Z");
const at = (agoMs: number) => new Date(NOW - agoMs);

describe("mapPin", () => {
  it("pins a vehicle whose last fix is recent", () => {
    expect(mapPin({ lat: 15.6, lng: 73.7, lastPingAt: at(60_000) }, NOW)).toEqual({ lat: 15.6, lng: 73.7 });
  });
  it("still pins at exactly 15 min", () => {
    expect(mapPin({ lat: 15.6, lng: 73.7, lastPingAt: at(MAP_PIN_MAX_AGE_MS) }, NOW)).toEqual({ lat: 15.6, lng: 73.7 });
  });
  it("drops the pin once the last fix is over 15 min old: it would look parked there", () => {
    expect(mapPin({ lat: 15.6, lng: 73.7, lastPingAt: at(MAP_PIN_MAX_AGE_MS + 1) }, NOW)).toBeNull();
  });
  it("no position, or a position with no fix time → no pin", () => {
    expect(mapPin({ lat: null, lng: null, lastPingAt: at(0) }, NOW)).toBeNull();
    expect(mapPin({ lat: 15.6, lng: 73.7, lastPingAt: null }, NOW)).toBeNull();
    expect(mapPin(undefined, NOW)).toBeNull();
  });
});
