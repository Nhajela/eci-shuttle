import { INITIAL_GEOFENCE_STATE } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import type { VehicleState } from "@/db/types";
import type { DeadZone } from "../signal/dead-zones";
import {
  lastSeenText,
  PREDICT_ARRIVAL_MARGIN_M,
  PREDICT_EXPIRY_FACTOR,
  PREDICT_MAX_MS,
  PREDICT_START_SLACK_M,
  type PredictRoute,
  sight,
} from "./sight";

const RIVA = "11111111-1111-4111-8111-111111111111";
const CIRCLE = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-19T13:30:00Z"); // 19:00 IST
const min = (n: number) => n * 60_000;
const MINUTE = 60_000;

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

describe("sight: predicted (a shuttle in a stretch with no mobile signal)", () => {
  const NANU = "33333333-3333-4333-8333-333333333333";
  const NAMAKA = "44444444-4444-4444-8444-444444444444";
  // Nanu → Riva → Circle → Namaka → Circle → Riva → Nanu; leg 2 (Circle → Namaka) is 1500 m, 600 s, no signal
  const ids = [NANU, RIVA, CIRCLE, NAMAKA, CIRCLE, RIVA, NANU];
  const alongs = [0, 1000, 2000, 3500, 5000, 6500, 7500];
  const zone = (over: Partial<DeadZone> = {}): DeadZone => ({
    routeId: "r1",
    legIndex: 2,
    fromSpotId: CIRCLE,
    toSpotId: NAMAKA,
    startAlongM: null,
    endAlongM: null,
    source: "manual",
    typicalLegS: 600,
    ...over,
  });
  const ctx = (
    zones: DeadZone[] = [zone()],
    legS: (number | null)[] = [],
    over: Partial<PredictRoute> = {},
  ): PredictRoute => ({
    routeId: "r1",
    spotIds: ids,
    spotAlongM: alongs,
    legS,
    zones,
    ...over,
  });
  /** left Circle 2.5 min before the last fix, 100 m into the leg, then silence for `silentMin` */
  const silent = (silentMin: number, over: Partial<VehicleState> = {}) =>
    state({
      phase: "en_route",
      spotId: CIRCLE,
      nextSpotId: NAMAKA,
      alongM: 2100,
      lastPingAt: new Date(NOW - min(silentMin)),
      since: new Date(NOW - min(silentMin + 2)),
      ...over,
    });
  const predicted = (v: ReturnType<typeof sight>) => {
    expect(v.kind).toBe("predicted");
    if (v.kind !== "predicted") throw new Error("not predicted");
    return v;
  };

  it("past the live window, in a dead leg: predicted, advancing at the leg's pace from the last fix", () => {
    // pace = 1500 m / 600 s = 2.5 m/s; 6 min silent = 900 m on from 2100
    const v = predicted(sight(silent(6), NOW, ctx()));
    expect(v.estimate).toMatchObject({
      legIndex: 2,
      fromSpotId: CIRCLE,
      toSpotId: NAMAKA,
      alongM: 3000,
      legStartM: 2000,
      legEndM: 3500,
      paceMps: 2.5,
      lastAlongM: 2100,
    });
    expect(v.estimate.legFraction).toBeCloseTo(2 / 3, 5);
    expect(v.ageMs).toBe(min(6));
    expect(v.last).toEqual({ at: NOW - min(6), atSpotId: null, fromSpotId: CIRCLE, toSpotId: NAMAKA });
    // usually arrives at: last fix + (3500 - 2100) m / 2.5 m/s = 560 s later
    expect(v.estimate.arrivesAtMs).toBe(NOW - min(6) + 560_000);
    // the state is an en_route one carrying the estimated place
    expect(v.state.phase).toBe("en_route");
    expect(v.state.alongM).toBe(3000);
  });

  it("the estimate advances with time", () => {
    const at = (m: number) => predicted(sight(silent(m), NOW, ctx())).estimate.alongM;
    expect(at(5.5)).toBeGreaterThan(2100);
    expect(at(7)).toBeGreaterThan(at(6));
    expect(at(8)).toBeGreaterThan(at(7));
  });

  it("never reaches the stop by prediction: clamped a little short of the end of the leg", () => {
    // 14 min silent = 2100 m of travel at 2.5 m/s, far past the 3500 m end
    const v = predicted(sight(silent(14), NOW, ctx()));
    expect(v.estimate.alongM).toBe(3500 - PREDICT_ARRIVAL_MARGIN_M);
    expect(v.estimate.legFraction).toBeLessThan(1);
  });

  it("live wins: up to 5 min it is live, and a fresh fix is live whatever came before", () => {
    expect(sight(silent(4), NOW, ctx()).kind).toBe("live");
    expect(sight(silent(5), NOW, ctx()).kind).toBe("live");
    const v = sight(silent(0.5), NOW, ctx());
    expect(v.kind).toBe("live");
    expect(sight(silent(5.01), NOW, ctx()).kind).toBe("predicted");
  });

  it("expires after 1.5 × the leg time (and the time left at the last fix, whichever is longer)", () => {
    expect(PREDICT_EXPIRY_FACTOR).toBe(1.5);
    // leg 600 s → 900 s = 15 min
    expect(sight(silent(15), NOW, ctx()).kind).toBe("predicted");
    expect(sight(silent(15.01), NOW, ctx()).kind).toBe("lost");
    // a fix that was just behind the leg start has more than a leg's time left: 1400 + ... → the longer one wins
    const early = silent(16, { alongM: 1800 }); // 1700 m left at 2.5 m/s = 680 s > 600 s → 1020 s = 17 min
    expect(sight(early, NOW, ctx()).kind).toBe("predicted");
    expect(sight(silent(17.5, { alongM: 1800 }), NOW, ctx()).kind).toBe("lost");
  });

  it("past the expiry the old ladder takes over: lost, then hidden after 30 min", () => {
    expect(sight(silent(20), NOW, ctx()).kind).toBe("lost");
    expect(sight(silent(31), NOW, ctx()).kind).toBe("hidden");
  });

  it("a long leg is predicted for longer than the old 30 min, but never beyond the cap", () => {
    // 1500 s leg → expiry 37.5 min, over the 30 min "hidden" of the plain ladder
    const slow = ctx([zone({ typicalLegS: 1500 })]);
    expect(sight(silent(35), NOW, slow).kind).toBe("predicted");
    expect(sight(silent(38), NOW, slow).kind).toBe("hidden");
    // an absurd leg time is capped
    const absurd = ctx([zone({ typicalLegS: 7200 })]);
    expect(sight(silent(PREDICT_MAX_MS / MINUTE), NOW, absurd).kind).toBe("predicted");
    expect(sight(silent(PREDICT_MAX_MS / MINUTE + 1), NOW, absurd).kind).toBe("hidden");
  });

  it("falls back to the leg estimate when the zone has no typical time; no time at all → no prediction", () => {
    const noTypical = ctx([zone({ typicalLegS: null })], [null, null, 300, null]);
    const v = predicted(sight(silent(6), NOW, noTypical));
    expect(v.estimate.paceMps).toBe(5);
    expect(sight(silent(6), NOW, ctx([zone({ typicalLegS: null })], [])).kind).toBe("lost");
    expect(sight(silent(6), NOW, ctx([zone({ typicalLegS: 0 })], [null, null, 0])).kind).toBe("lost");
  });

  it("the zone's typical time beats the leg estimate", () => {
    const v = predicted(sight(silent(6), NOW, ctx([zone({ typicalLegS: 600 })], [null, null, 300])));
    expect(v.estimate.paceMps).toBe(2.5);
  });

  it("not predicted without a dead zone, on another leg, on another route, or for a stale zone", () => {
    expect(sight(silent(6), NOW).kind).toBe("lost");
    expect(sight(silent(6), NOW, ctx([])).kind).toBe("lost");
    expect(sight(silent(6), NOW, ctx([zone({ legIndex: 1, fromSpotId: RIVA, toSpotId: CIRCLE })])).kind).toBe("lost");
    expect(sight(silent(6), NOW, ctx([zone({ routeId: "other" })])).kind).toBe("lost");
    // the route was edited: the zone's stops no longer match that leg
    expect(sight(silent(6), NOW, ctx([zone({ toSpotId: RIVA })])).kind).toBe("lost");
  });

  it("the way back (Namaka → Circle) is its own leg: the outbound zone does not cover it", () => {
    const back = silent(6, { spotId: NAMAKA, nextSpotId: CIRCLE, alongM: 3600 });
    expect(sight(back, NOW, ctx()).kind).toBe("lost");
    const both = ctx([zone(), zone({ legIndex: 3, fromSpotId: NAMAKA, toSpotId: CIRCLE })]);
    const v = predicted(sight(back, NOW, both));
    expect(v.estimate.legIndex).toBe(3);
    expect(v.estimate.toSpotId).toBe(CIRCLE);
  });

  it("a partial zone: the last fix at or just before its start, or inside it, is predicted", () => {
    const part = ctx([zone({ startAlongM: 2400, endAlongM: 3300 })]);
    // at the start, a little before (within the slack), inside
    expect(sight(silent(6, { alongM: 2400 }), NOW, part).kind).toBe("predicted");
    expect(sight(silent(6, { alongM: 2400 - PREDICT_START_SLACK_M }), NOW, part).kind).toBe("predicted");
    expect(sight(silent(6, { alongM: 2900 }), NOW, part).kind).toBe("predicted");
    // too far before the zone: the signal was fine there, so the silence is not the dead zone
    expect(sight(silent(6, { alongM: 2400 - PREDICT_START_SLACK_M - 1 }), NOW, part).kind).toBe("lost");
    // already past the end of the stretch: it had signal again, so no
    expect(sight(silent(6, { alongM: 3300 }), NOW, part).kind).toBe("lost");
  });

  it("a fix at the very end of the leg still predicts, held at where it was (never going backwards)", () => {
    const v = predicted(sight(silent(6, { alongM: 3450 }), NOW, ctx()));
    expect(v.estimate.alongM).toBe(3450);
  });

  it("works from an 'offline' state between stops (ingest marks it offline after 2 min), not from one inside a stop", () => {
    const off = silent(6, { phase: "offline", since: new Date(NOW - min(4)) });
    const v = predicted(sight(off, NOW, ctx()));
    expect(v.state.phase).toBe("en_route");
    const parkedAtCircle = silent(6, {
      phase: "offline",
      geofence: { ...INITIAL_GEOFENCE_STATE, insideSpotId: CIRCLE, enteredAt: NOW - min(9) },
    });
    expect(sight(parkedAtCircle, NOW, ctx()).kind).not.toBe("predicted");
  });

  it("not for a vehicle at a stop, off the route, or without a place along the route", () => {
    // at Circle at its last fix: the old "parked, may still be there" ladder (we cannot know it has left)
    expect(sight(silent(6, { phase: "at_spot", spotId: CIRCLE }), NOW, ctx()).kind).toBe("parked");
    expect(sight(silent(6, { offRoute: true }), NOW, ctx()).kind).toBe("lost");
    expect(sight(silent(6, { alongM: null }), NOW, ctx()).kind).toBe("lost");
    expect(sight(silent(6, { nextSpotId: null }), NOW, ctx()).kind).toBe("lost");
    expect(sight(silent(6, { lastPingAt: null }), NOW, ctx()).kind).toBe("hidden");
  });

  it("a route that passes the same two stops twice picks the leg by where the vehicle is", () => {
    // Riva → Circle → Riva → Circle (a loop run twice): zone on the second Riva → Circle only
    const twice = ctx([zone({ legIndex: 2, fromSpotId: RIVA, toSpotId: CIRCLE })], [], {
      spotIds: [RIVA, CIRCLE, RIVA, CIRCLE],
      spotAlongM: [0, 1000, 2000, 3000],
    });
    const second = silent(6, { spotId: RIVA, nextSpotId: CIRCLE, alongM: 2100 });
    expect(predicted(sight(second, NOW, twice)).estimate.legIndex).toBe(2);
    const first = silent(6, { spotId: RIVA, nextSpotId: CIRCLE, alongM: 100 });
    expect(sight(first, NOW, twice).kind).toBe("lost");
  });

  it("a malformed context (no per-spot distances, zero-length leg) never predicts", () => {
    expect(sight(silent(6), NOW, ctx([zone()], [], { spotAlongM: [] })).kind).toBe("lost");
    expect(sight(silent(6), NOW, ctx([zone()], [], { spotAlongM: [0, 1000, 2000, 2000, 5000, 6500, 7500] })).kind).toBe(
      "lost",
    );
  });
});
