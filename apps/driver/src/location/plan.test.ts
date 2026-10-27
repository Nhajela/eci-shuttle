import type { DeviceConfig, ModeResolution, Window } from "@eci-shuttle/shared/contracts";
import { describe, expect, it } from "vitest";
import {
  type Fix,
  gateFixes,
  isForegroundNotAllowed,
  locationPlan,
  nativeDecision,
  planKey,
  TRACKING_HORIZON_MS,
  toPing,
} from "./plan";

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
const CFG = { activeIntervalS: 10, idleHeartbeatS: 900 };
const HOUR = 3_600_000;

describe("locationPlan: one tracking-day task, fixed options", () => {
  const active = res({ mode: "active", intervalS: 10, until: at(11), window: win() });

  it("active: High accuracy at the active interval", () => {
    expect(locationPlan(active, CFG, now)).toMatchObject({
      run: true,
      mode: "active",
      highAccuracy: true,
      timeIntervalMs: 10_000,
    });
  });

  it("idle before a window inside the horizon: same options as active (the task is not retuned)", () => {
    const idle = locationPlan(res({ until: now + 5 * HOUR }), CFG, now);
    const act = locationPlan(active, CFG, now);
    expect(idle).toMatchObject({ run: true, mode: "idle", highAccuracy: true, timeIntervalMs: 10_000 });
    expect(planKey(idle)).toBe(planKey(act));
  });

  it("a window's own interval changes the gate, not the native task", () => {
    const p = locationPlan(res({ mode: "active", intervalS: 30, window: win({ intervalS: 30 }) }), CFG, now);
    expect(p).toMatchObject({ timeIntervalMs: 10_000 });
  });

  it("idle with the next change beyond the horizon, or none: no tracking", () => {
    expect(locationPlan(res({ until: now + TRACKING_HORIZON_MS + 60_000 }), CFG, now)).toEqual({ run: false });
    expect(locationPlan(res({ until: null }), CFG, now)).toEqual({ run: false });
    expect(locationPlan(res({ until: now + TRACKING_HORIZON_MS }), CFG, now)).toMatchObject({ run: true });
  });

  it("killed, revoked and unpaired: no tracking", () => {
    for (const mode of ["killed", "revoked", "unpaired"] as const) {
      expect(locationPlan(res({ mode, intervalS: null }), CFG, now)).toEqual({ run: false });
    }
  });

  it("the notification text is fixed: no countdown, no clock", () => {
    const a = locationPlan(active, CFG, now);
    const b = locationPlan(res({ until: now + 5 * HOUR }), CFG, now + 7 * 60_000);
    if (!a.run || !b.run) throw new Error("expected run");
    expect(a.notification).toEqual(b.notification);
    expect(JSON.stringify(a.notification)).not.toMatch(/\d:\d\d|until/i);
  });

  it("planKey does not change as time passes towards a window, or when the mode flips", () => {
    const keys = new Set<string>();
    for (const m of [0, 1, 7, 60, 200]) {
      keys.add(planKey(locationPlan(res({ until: now + 5 * HOUR }), CFG, now + m * 60_000)));
      keys.add(planKey(locationPlan(res({ mode: "active", intervalS: 10, until: now + m * 60_000 }), CFG, now)));
    }
    expect(keys.size).toBe(1);
  });

  it("planKey changes when the accuracy or interval does, and for stop", () => {
    const k = planKey(locationPlan(active, CFG, now));
    expect(planKey(locationPlan(active, { ...CFG, activeIntervalS: 5 }, now))).not.toBe(k);
    expect(planKey({ run: false })).toBe("stop");
  });
});

describe("nativeDecision: the native task is only touched while the app is on screen", () => {
  const run = locationPlan(res({ until: now + HOUR }), CFG, now);
  const stop = { run: false } as const;
  const key = planKey(run);

  it("foreground, not running: start", () => {
    expect(nativeDecision({ plan: run, running: false, startedKey: null, foreground: true })).toEqual({
      action: "start",
      needsApp: false,
    });
  });
  it("foreground, running with the right options: nothing to do", () => {
    expect(nativeDecision({ plan: run, running: true, startedKey: key, foreground: true })).toEqual({
      action: "none",
      needsApp: false,
    });
  });
  it("foreground, running with other or unknown options (an older build's task): restart it", () => {
    expect(nativeDecision({ plan: run, running: true, startedKey: "low|900000", foreground: true }).action).toBe(
      "start",
    );
    expect(nativeDecision({ plan: run, running: true, startedKey: null, foreground: true }).action).toBe("start");
  });
  it("foreground, task died but we remember starting it: start again", () => {
    expect(nativeDecision({ plan: run, running: false, startedKey: key, foreground: true }).action).toBe("start");
  });
  it("background: never start or change; flag that the app must be opened when the task isn't right", () => {
    expect(nativeDecision({ plan: run, running: false, startedKey: null, foreground: false })).toEqual({
      action: "none",
      needsApp: true,
    });
    expect(nativeDecision({ plan: run, running: true, startedKey: null, foreground: false })).toEqual({
      action: "none",
      needsApp: true,
    });
    expect(nativeDecision({ plan: run, running: true, startedKey: key, foreground: false })).toEqual({
      action: "none",
      needsApp: false,
    });
  });
  it("stop only in the foreground; in the background the gate drops the fixes instead", () => {
    expect(nativeDecision({ plan: stop, running: true, startedKey: key, foreground: true }).action).toBe("stop");
    expect(nativeDecision({ plan: stop, running: true, startedKey: key, foreground: false })).toEqual({
      action: "none",
      needsApp: false,
    });
    expect(nativeDecision({ plan: stop, running: false, startedKey: null, foreground: true }).action).toBe("none");
  });
});

describe("isForegroundNotAllowed", () => {
  it("recognises expo-location's background-start refusal", () => {
    expect(
      isForegroundNotAllowed(Object.assign(new Error("x"), { code: "ERR_FOREGROUND_SERVICE_START_NOT_ALLOWED" })),
    ).toBe(true);
    expect(
      isForegroundNotAllowed(
        new Error(
          "Couldn't start the foreground service. Foreground service cannot be started when the application is in the background",
        ),
      ),
    ).toBe(true);
    expect(isForegroundNotAllowed(new Error("Missing location permissions"))).toBe(false);
    expect(isForegroundNotAllowed("nope")).toBe(false);
  });
});

describe("gateFixes: what the JS side keeps from the always-on task", () => {
  const dc = (schedule: Window[]): DeviceConfig => ({
    configVersion: 1,
    killed: false,
    revoked: false,
    schedule,
    activeIntervalS: 10,
    idleHeartbeatS: 900,
  });
  const fix = (t: number): Fix => ({
    timestamp: t,
    coords: { latitude: 1, longitude: 2, accuracy: 5, speed: null, heading: null },
  });
  const times = (fs: Fix[]) => fs.map((f) => f.timestamp);
  const run = win({ startsAt: at(8), endsAt: at(11) });

  it("active: keeps fixes at the active cadence, with slack for jitter", () => {
    const t0 = at(9);
    const g = gateFixes([fix(t0), fix(t0 + 9_000), fix(t0 + 19_000), fix(t0 + 29_000)], dc([run]), 0, null);
    expect(times(g.keep)).toEqual([t0, t0 + 9_000, t0 + 19_000, t0 + 29_000]);
    expect(g.lastKeptAt).toBe(t0 + 29_000);
  });

  it("active: a window with a slower interval thins the 10 s fixes down to it", () => {
    const t0 = at(9);
    const slow = win({ startsAt: at(8), endsAt: at(11), intervalS: 30 });
    const g = gateFixes(
      [0, 10, 20, 30, 40, 50, 60].map((s) => fix(t0 + s * 1000)),
      dc([slow]),
      0,
      null,
    );
    expect(times(g.keep)).toEqual([t0, t0 + 30_000, t0 + 60_000]);
  });

  it("idle: keeps one fix per heartbeat and drops the rest", () => {
    const t0 = at(12);
    const g = gateFixes([fix(t0), fix(t0 + 10_000), fix(t0 + 14 * 60_000), fix(t0 + 15 * 60_000)], dc([run]), 0, null);
    expect(times(g.keep)).toEqual([t0, t0 + 14 * 60_000]);
  });

  it("carries the cadence across calls through lastKeptAt", () => {
    const t0 = at(12);
    const g = gateFixes([fix(t0 + 60_000)], dc([run]), 0, t0);
    expect(g.keep).toEqual([]);
    expect(g.lastKeptAt).toBe(t0);
  });

  it("judges each fix by its own server time (clock offset applied)", () => {
    const g = gateFixes([fix(at(11) - 5_000 - 60_000)], dc([run]), 60_000, null);
    expect(g.keep).toHaveLength(1); // 5 s before the end on server time: active
  });

  it("killed, revoked, unpaired: drops everything", () => {
    const f = [fix(at(9))];
    expect(gateFixes(f, { ...dc([run]), killed: true }, 0, null).keep).toEqual([]);
    expect(gateFixes(f, { ...dc([run]), revoked: true }, 0, null).keep).toEqual([]);
    expect(gateFixes(f, null, 0, null).keep).toEqual([]);
  });

  it("sorts a batch by time first", () => {
    const t0 = at(9);
    expect(times(gateFixes([fix(t0 + 20_000), fix(t0)], dc([run]), 0, null).keep)).toEqual([t0, t0 + 20_000]);
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
