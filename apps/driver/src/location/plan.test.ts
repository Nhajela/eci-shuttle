import type { ModeResolution, Window } from "@eci-shuttle/shared/contracts";
import { describe, expect, it } from "vitest";
import { istClock, locationPlan, notificationText, planKey, toPing } from "./plan";

// 2026-10-12 09:00 IST = 03:30 UTC
const now = Date.UTC(2026, 9, 12, 3, 30);
const at = (h: number, m = 0, dayOffset = 0) => Date.UTC(2026, 9, 12 + dayOffset, h, m) - 330 * 60_000;
const win = (over: Partial<Window> = {}): Window => ({
  startsAt: at(8),
  endsAt: at(11),
  mode: "active",
  intervalS: null,
  source: "service",
  label: "Riva ↔ Circle",
  ...over,
});
const res = (over: Partial<ModeResolution>): ModeResolution => ({
  mode: "idle",
  intervalS: 900,
  until: null,
  window: null,
  next: null,
  ...over,
});
const HEARTBEAT = 900;

describe("istClock", () => {
  it("shows HH:MM in IST for the same IST day", () => {
    expect(istClock(at(11), now)).toBe("11:00");
    expect(istClock(at(16, 5), now)).toBe("16:05");
  });
  it("adds the weekday when the time is on another IST day", () => {
    expect(istClock(at(7, 0, 1), now)).toBe("Tue 07:00");
  });
  it("uses the IST day, not the UTC day (00:30 IST is still the previous UTC day)", () => {
    const lateNight = at(23, 0);
    expect(istClock(at(0, 30, 1), lateNight)).toBe("Tue 00:30");
  });
});

describe("notificationText (SPEC §4: notification always shows the current state)", () => {
  it("active with an end time and label", () => {
    expect(notificationText(res({ mode: "active", intervalS: 10, until: at(11), window: win() }), now)).toEqual({
      title: "Sharing location until 11:00",
      body: "Riva ↔ Circle",
    });
  });
  it("active with no end in the schedule", () => {
    expect(notificationText(res({ mode: "active", intervalS: 10, window: win({ label: null }) }), now).title).toBe(
      "Sharing location",
    );
  });
  it("idle until the next window", () => {
    expect(notificationText(res({ until: at(16) }), now).title).toBe("Paused until 16:00");
  });
  it("idle with nothing scheduled", () => {
    expect(notificationText(res({}), now)).toEqual({ title: "Paused", body: "Not sharing location" });
  });
});

describe("locationPlan", () => {
  it("active: high accuracy at the resolved interval, records pings", () => {
    const p = locationPlan(res({ mode: "active", intervalS: 10, until: at(11), window: win() }), HEARTBEAT, now);
    expect(p).toMatchObject({ run: true, recordPings: true, highAccuracy: true, timeIntervalMs: 10_000 });
    if (p.run) expect(p.notification.title).toBe("Sharing location until 11:00");
  });

  it("idle: low power clock at the heartbeat, never records pings", () => {
    const p = locationPlan(res({ until: at(16) }), HEARTBEAT, now);
    expect(p).toMatchObject({ run: true, recordPings: false, highAccuracy: false, timeIntervalMs: 900_000 });
  });

  it("idle: wakes no later than the next window start, so tracking starts on time", () => {
    const p = locationPlan(res({ until: now + 7 * 60_000 }), HEARTBEAT, now);
    expect(p).toMatchObject({ timeIntervalMs: 7 * 60_000 });
  });

  it("idle: never asks for a wake under a minute", () => {
    const p = locationPlan(res({ until: now + 5_000 }), HEARTBEAT, now);
    expect(p).toMatchObject({ timeIntervalMs: 60_000 });
  });

  it("killed, revoked and unpaired stop the service (notification removed)", () => {
    for (const mode of ["killed", "revoked", "unpaired"] as const) {
      expect(locationPlan(res({ mode, intervalS: null }), HEARTBEAT, now)).toEqual({ run: false });
    }
  });

  it("planKey is stable for the same plan and changes when anything the service shows changes", () => {
    const a = locationPlan(res({ until: at(16) }), HEARTBEAT, now);
    expect(planKey(a)).toBe(planKey(locationPlan(res({ until: at(16) }), HEARTBEAT, now + 60_000)));
    expect(planKey(a)).not.toBe(planKey(locationPlan(res({ until: at(17) }), HEARTBEAT, now)));
    expect(planKey({ run: false })).toBe("stop");
  });
});

describe("toPing", () => {
  const loc = {
    timestamp: 1_760_000_000_123.7,
    coords: {
      latitude: 15.6,
      longitude: 73.7,
      accuracy: 8,
      speed: 4.2,
      heading: 90,
      altitude: null,
      altitudeAccuracy: null,
    },
  };
  it("maps a fix to the protocol Ping", () => {
    expect(toPing(loc, 55)).toEqual({
      recordedAt: 1_760_000_000_124,
      lat: 15.6,
      lng: 73.7,
      accuracy: 8,
      speed: 4.2,
      heading: 90,
      battery: 55,
    });
  });
  it("turns Android's 'unknown' speed/heading (null, negative) into null", () => {
    const p = toPing({ ...loc, coords: { ...loc.coords, speed: -1, heading: null } }, null);
    expect(p).toMatchObject({ speed: null, heading: null, battery: null });
  });
  it("drops a fix with no accuracy, since the server can't weigh it", () => {
    expect(toPing({ ...loc, coords: { ...loc.coords, accuracy: null } }, 55)).toBeNull();
  });
});
