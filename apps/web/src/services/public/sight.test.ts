import { INITIAL_GEOFENCE_STATE } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import type { VehicleState } from "@/db/types";
import { lastSeenText, sight } from "./sight";

const RIVA = "11111111-1111-4111-8111-111111111111";
const CIRCLE = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-19T13:30:00Z"); // 19:00 IST
const min = (n: number) => n * 60_000;

function state(over: Partial<VehicleState>): VehicleState {
  return {
    vehicleId: "v1",
    workspaceId: "w1",
    serviceId: "s1",
    phase: "en_route",
    spotId: RIVA,
    nextSpotId: CIRCLE,
    since: new Date(NOW - min(3)),
    etaS: null,
    lastPingAt: new Date(NOW - min(1)),
    lat: 15.67,
    lng: 73.71,
    alongM: 500,
    offRoute: false,
    offRouteSince: null,
    geofence: { ...INITIAL_GEOFENCE_STATE },
    updatedAt: new Date(NOW),
    ...over,
  };
}

describe("sight: how well we can see a shuttle, from its last position", () => {
  it("live up to 5 min: its phase stands, with how old the position is", () => {
    const s = state({ lastPingAt: new Date(NOW - min(4)) });
    const v = sight(s, NOW);
    expect(v.kind).toBe("live");
    if (v.kind !== "live") return;
    expect(v.ageMs).toBe(min(4));
    expect(v.state.phase).toBe("en_route");
    expect(v.state.nextSpotId).toBe(CIRCLE);
  });

  it("marked offline after 2 min: the last stop is rebuilt from the geofence, arrival time included", () => {
    const s = state({
      phase: "offline",
      since: new Date(NOW - min(1)),
      lastPingAt: new Date(NOW - min(3)),
      geofence: { ...INITIAL_GEOFENCE_STATE, insideSpotId: RIVA, enteredAt: NOW - min(9) },
    });
    const v = sight(s, NOW);
    expect(v.kind).toBe("live");
    if (v.kind !== "live") return;
    expect(v.state.phase).toBe("at_spot");
    expect(v.state.spotId).toBe(RIVA);
    expect(v.state.since.getTime()).toBe(NOW - min(9));
  });

  it("marked offline between stops: on its way again, but never a fresh departure (since = epoch)", () => {
    const s = state({ phase: "offline", since: new Date(NOW - min(1)), lastPingAt: new Date(NOW - min(3)) });
    const v = sight(s, NOW);
    expect(v.kind).toBe("live");
    if (v.kind !== "live") return;
    expect(v.state.phase).toBe("en_route");
    expect(v.state.since.getTime()).toBe(0);
  });

  it("parked: last seen inside a stop, 5 to 15 min ago", () => {
    const s = state({
      phase: "offline",
      lastPingAt: new Date(NOW - min(12)),
      geofence: { ...INITIAL_GEOFENCE_STATE, insideSpotId: RIVA, enteredAt: NOW - min(20) },
    });
    expect(sight(s, NOW)).toEqual({
      kind: "parked",
      spotId: RIVA,
      last: { at: NOW - min(12), atSpotId: RIVA, fromSpotId: null, toSpotId: null },
    });
  });

  it("lost: out of sight for 5 to 30 min (or parked longer than 15)", () => {
    expect(sight(state({ phase: "offline", lastPingAt: new Date(NOW - min(6)) }), NOW)).toEqual({
      kind: "lost",
      last: { at: NOW - min(6), atSpotId: null, fromSpotId: RIVA, toSpotId: CIRCLE },
    });
    const parkedLong = state({
      phase: "offline",
      lastPingAt: new Date(NOW - min(20)),
      geofence: { ...INITIAL_GEOFENCE_STATE, insideSpotId: RIVA, enteredAt: NOW - min(25) },
    });
    expect(sight(parkedLong, NOW).kind).toBe("lost");
  });

  it("hidden: silent for more than 30 min, or never seen", () => {
    expect(sight(state({ phase: "offline", lastPingAt: new Date(NOW - min(31)) }), NOW).kind).toBe("hidden");
    expect(sight(state({ lastPingAt: null }), NOW)).toEqual({ kind: "hidden", last: null });
    expect(sight(null, NOW)).toEqual({ kind: "hidden", last: null });
  });
});

describe("lastSeenText", () => {
  const name = (id: string) => (id === RIVA ? "Riva" : "Circle");
  it("where and when, in IST; only today's", () => {
    expect(lastSeenText({ at: NOW - min(2), atSpotId: RIVA, fromSpotId: null, toSpotId: null }, name, NOW)).toBe(
      "at Riva at 18:58",
    );
    expect(lastSeenText({ at: NOW - min(2), atSpotId: null, fromSpotId: RIVA, toSpotId: CIRCLE }, name, NOW)).toBe(
      "on its way to Circle at 18:58",
    );
    expect(lastSeenText({ at: NOW - min(2), atSpotId: null, fromSpotId: RIVA, toSpotId: null }, name, NOW)).toBe(
      "after leaving Riva at 18:58",
    );
    expect(lastSeenText({ at: NOW - min(2), atSpotId: null, fromSpotId: null, toSpotId: null }, name, NOW)).toBe(
      "at 18:58",
    );
    expect(lastSeenText({ at: NOW - 86_400_000, atSpotId: RIVA, fromSpotId: null, toSpotId: null }, name, NOW)).toBe(
      null,
    );
  });
});
