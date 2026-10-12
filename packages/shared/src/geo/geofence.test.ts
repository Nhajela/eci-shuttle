import { describe, expect, it } from "vitest";
import { type Fix, type GeofenceSpot, type GeofenceState, INITIAL_GEOFENCE_STATE } from "../contracts";
import { geofenceStep } from "./geofence";

const LAT = 15.65;
const LNG = 73.72;
const M_PER_DEG_LAT = 111_195; // haversine with R = 6371 km
const north = (m: number) => LAT + m / M_PER_DEG_LAT;

const A: GeofenceSpot = { id: "a", lat: LAT, lng: LNG, radiusM: 50 };
const B: GeofenceSpot = { id: "b", lat: north(1000), lng: LNG, radiusM: 50 };
const T0 = 1_700_000_000_000;

const fix = (sec: number, mNorth: number, accuracy = 10): Fix => ({
  at: T0 + sec * 1000,
  lat: north(mNorth),
  lng: LNG,
  accuracy,
});

/** feed fixes in order from a state; returns final state and all events */
function run(fixes: Fix[], spots: GeofenceSpot[] = [A, B], start: GeofenceState = INITIAL_GEOFENCE_STATE) {
  let state = start;
  const events = [];
  for (const f of fixes) {
    const r = geofenceStep(state, f, spots);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

const insideA: GeofenceState = { ...INITIAL_GEOFENCE_STATE, insideSpotId: "a", enteredAt: T0, lastFixAt: T0 };

describe("geofenceStep", () => {
  it("first fix inside a spot makes it the candidate, no event", () => {
    const { state, events } = run([fix(0, 10)]);
    expect(events).toEqual([]);
    expect(state).toEqual({ ...INITIAL_GEOFENCE_STATE, candidateSpotId: "a", candidateSince: T0, lastFixAt: T0 });
  });

  it("still inside 20 s later → arrived, at = candidateSince", () => {
    const { state, events } = run([fix(0, 10), fix(10, 20), fix(20, 0)]);
    expect(events).toEqual([{ kind: "arrived", spotId: "a", at: T0 }]);
    expect(state).toEqual({
      insideSpotId: "a",
      enteredAt: T0,
      candidateSpotId: null,
      candidateSince: null,
      lastFixAt: T0 + 20_000,
    });
  });

  it("inside for 19 s then out → no arrival, candidate cleared", () => {
    const { state, events } = run([fix(0, 10), fix(19, 10), fix(25, 200), fix(40, 10)]);
    expect(events).toEqual([]);
    expect(state.insideSpotId).toBeNull();
    // re-entry restarts the dwell clock
    expect(state.candidateSince).toBe(T0 + 40_000);
  });

  it("fix with accuracy > 100 m is ignored entirely (lastFixAt unchanged)", () => {
    const start = run([fix(0, 10)]).state;
    const r = geofenceStep(start, fix(30, 10, 101), [A, B]);
    expect(r).toEqual({ state: start, events: [] });
  });

  it("accuracy exactly 100 m is used", () => {
    const { events } = run([fix(0, 10, 100), fix(20, 10, 100)]);
    expect(events).toEqual([{ kind: "arrived", spotId: "a", at: T0 }]);
  });

  it("duplicate or older fix is ignored", () => {
    const start = run([fix(0, 10), fix(10, 10)]).state;
    expect(geofenceStep(start, fix(10, 10), [A, B])).toEqual({ state: start, events: [] });
    expect(geofenceStep(start, fix(5, 500), [A, B])).toEqual({ state: start, events: [] });
  });

  it("inside: drifting between radius and 1.5× radius does not depart (hysteresis)", () => {
    const { state, events } = run([fix(10, 60), fix(20, 74), fix(30, 55)], [A, B], insideA);
    expect(events).toEqual([]);
    expect(state.insideSpotId).toBe("a");
    expect(state.enteredAt).toBe(T0);
  });

  it("inside: first fix beyond 1.5× radius → departed at fix.at", () => {
    const { state, events } = run([fix(10, 70), fix(20, 80)], [A, B], insideA);
    expect(events).toEqual([{ kind: "departed", spotId: "a", at: T0 + 20_000 }]);
    expect(state).toEqual({ ...INITIAL_GEOFENCE_STATE, lastFixAt: T0 + 20_000 });
  });

  it("depart one spot and become candidate for another in one step", () => {
    const near = { ...B, lat: north(100) };
    const r = geofenceStep(insideA, fix(10, 90), [A, near]);
    expect(r.events).toEqual([{ kind: "departed", spotId: "a", at: T0 + 10_000 }]);
    expect(r.state).toEqual({
      ...INITIAL_GEOFENCE_STATE,
      candidateSpotId: "b",
      candidateSince: T0 + 10_000,
      lastFixAt: T0 + 10_000,
    });
  });

  it("overlapping spots → nearest centre wins", () => {
    const big: GeofenceSpot = { id: "big", lat: north(-150), lng: LNG, radiusM: 300 };
    const { events } = run([fix(0, 10), fix(20, 10)], [big, A]);
    expect(events).toEqual([{ kind: "arrived", spotId: "a", at: T0 }]);
    // a spot whose centre is nearer but whose radius doesn't contain the fix does not win
    const small: GeofenceSpot = { id: "small", lat: north(80), lng: LNG, radiusM: 20 };
    expect(run([fix(0, 40)], [A, small]).state.candidateSpotId).toBe("a");
  });

  it("inside a spot that was archived (not in spots) → departed", () => {
    const r = geofenceStep(insideA, fix(10, 0), [B]);
    expect(r.events).toEqual([{ kind: "departed", spotId: "a", at: T0 + 10_000 }]);
    expect(r.state.insideSpotId).toBeNull();
  });

  it("GPS gap: a fix 10 min later still inside keeps the vehicle inside without a new arrival", () => {
    const { state, events } = run([fix(600, 10)], [A, B], insideA);
    expect(events).toEqual([]);
    expect(state).toEqual({ ...insideA, lastFixAt: T0 + 600_000 });
  });
});
