import type { DeviceConfig, ModeResolution, Window } from "@eci-shuttle/shared/contracts";
import { describe, expect, it } from "vitest";
import {
  type Capability,
  capabilityFor,
  type Fix,
  gateFixes,
  IDLE_STOP_AFTER_MS,
  isForegroundNotAllowed,
  locationPlan,
  nativeDecision,
  planKey,
  reminderAction,
  reminderTarget,
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

const P: Capability = "patched";
const U: Capability = "unpatched";

describe("capabilityFor: what this build's expo-location can do", () => {
  it("0.1.1 and later are patched; 0.1.0, unknown and garbage are not", () => {
    expect(capabilityFor("0.1.1", false)).toBe("patched");
    expect(capabilityFor("0.2.0", false)).toBe("patched");
    expect(capabilityFor("1.0", false)).toBe("patched");
    expect(capabilityFor("0.1.0", false)).toBe("unpatched");
    expect(capabilityFor(null, false)).toBe("unpatched");
    expect(capabilityFor("", false)).toBe("unpatched");
  });
  it("a patched build whose in-place update was refused in the background falls back to unpatched", () => {
    expect(capabilityFor("0.1.1", true)).toBe("unpatched");
  });
});

describe("locationPlan: patched (per-mode options, in-place updates)", () => {
  const active = res({ mode: "active", intervalS: 10, until: at(11), window: win() });

  it("active: High accuracy at the active interval", () => {
    expect(locationPlan(active, CFG, now, P)).toMatchObject({
      run: true,
      mode: "active",
      highAccuracy: true,
      timeIntervalMs: 10_000,
    });
  });

  it("idle: Lowest accuracy at the idle heartbeat, however far the next window is (never stopped for idle)", () => {
    for (const until of [now + HOUR, now + 11 * HOUR, now + 40 * HOUR, null]) {
      expect(locationPlan(res({ until }), CFG, now, P)).toMatchObject({
        run: true,
        mode: "idle",
        highAccuracy: false,
        timeIntervalMs: 900_000,
      });
    }
  });

  it("killed, revoked and unpaired stop", () => {
    for (const mode of ["killed", "revoked", "unpaired"] as const) {
      expect(locationPlan(res({ mode, intervalS: null }), CFG, now, P)).toEqual({ run: false });
    }
  });

  it("the key follows mode/accuracy/interval, and nothing else", () => {
    const keys = new Set<string>();
    for (const m of [0, 1, 7, 60, 200]) {
      keys.add(planKey(locationPlan(res({ until: now + 5 * HOUR }), CFG, now + m * 60_000, P)));
      keys.add(planKey(locationPlan(res({ until: now + m * 60_000 + 1 }), CFG, now, P)));
    }
    expect(keys.size).toBe(1); // idle, however close the window gets
    expect(planKey(locationPlan(active, CFG, now, P))).not.toBe([...keys][0]);
    expect(planKey(locationPlan(active, { ...CFG, activeIntervalS: 5 }, now, P))).not.toBe(
      planKey(locationPlan(active, CFG, now, P)),
    );
    expect(planKey({ run: false })).toBe("stop");
  });
});

describe("locationPlan: the native interval is the fastest an active window needs", () => {
  const fast = res({ mode: "active", intervalS: 5, until: at(11), window: win({ intervalS: 5 }) });
  const slow = res({ mode: "active", intervalS: 30, until: at(11), window: win({ intervalS: 30 }) });

  it("patched: a force_active window faster than the config interval gets its own interval", () => {
    expect(locationPlan(fast, CFG, now, P)).toMatchObject({ run: true, mode: "active", timeIntervalMs: 5_000 });
  });

  it("unpatched: the key stays at the config interval (a change can't be applied from the background)", () => {
    expect(locationPlan(fast, CFG, now, U)).toMatchObject({ run: true, mode: "active", timeIntervalMs: 10_000 });
    expect(planKey(locationPlan(fast, CFG, now, U))).toBe(planKey(locationPlan(slow, CFG, now, U)));
  });

  it("a slower window never slows the task below the config interval", () => {
    expect(locationPlan(slow, CFG, now, P)).toMatchObject({ timeIntervalMs: 10_000 });
  });

  it("the key changes with the minimum, and only with it", () => {
    expect(planKey(locationPlan(fast, CFG, now, P))).not.toBe(planKey(locationPlan(slow, CFG, now, P)));
    expect(planKey(locationPlan(slow, CFG, now, P))).toBe(
      planKey(locationPlan(res({ mode: "active", intervalS: 10, window: win() }), CFG, now, P)),
    );
  });

  it("unpatched idle before a fast window keeps the config interval, same key as active", () => {
    const idle = res({ until: now + HOUR, next: win({ intervalS: 5 }) });
    const p = locationPlan(idle, CFG, now, U);
    expect(p).toMatchObject({ run: true, mode: "idle", timeIntervalMs: 10_000 });
    expect(planKey(p)).toBe(planKey(locationPlan(fast, CFG, now, U)));
  });

  it("patched idle keeps the heartbeat whatever the next window wants", () => {
    const idle = res({ until: now + HOUR, next: win({ intervalS: 5 }) });
    expect(locationPlan(idle, CFG, now, P)).toMatchObject({ highAccuracy: false, timeIntervalMs: 900_000 });
  });
});

describe("locationPlan: unpatched (one fixed task per tracking day)", () => {
  const active = res({ mode: "active", intervalS: 10, until: at(11), window: win() });

  it("active: High at the active interval", () => {
    expect(locationPlan(active, CFG, now, U)).toMatchObject({ run: true, highAccuracy: true, timeIntervalMs: 10_000 });
  });

  it("idle with a window within 3 h: the same options as active, so the key does not change", () => {
    const idle = locationPlan(res({ until: now + IDLE_STOP_AFTER_MS }), CFG, now, U);
    expect(idle).toMatchObject({ run: true, mode: "idle", highAccuracy: true, timeIntervalMs: 10_000 });
    expect(planKey(idle)).toBe(planKey(locationPlan(active, CFG, now, U)));
  });

  it("idle with the next window beyond 3 h, or none: stop (no all-night GPS)", () => {
    expect(locationPlan(res({ until: now + IDLE_STOP_AFTER_MS + 60_000 }), CFG, now, U)).toEqual({ run: false });
    expect(locationPlan(res({ until: now + 11 * HOUR }), CFG, now, U)).toEqual({ run: false });
    expect(locationPlan(res({ until: null }), CFG, now, U)).toEqual({ run: false });
  });

  it("charging: no overnight stop (a missed reminder must not mean no tracking all day), up to 16 h ahead", () => {
    const plugged = { ...CFG, charging: true };
    const far = res({ until: now + 11 * HOUR });
    expect(locationPlan(far, plugged, now, U)).toMatchObject({ run: true, mode: "idle", highAccuracy: true });
    expect(planKey(locationPlan(far, plugged, now, U))).toBe(planKey(locationPlan(active, plugged, now, U)));
    expect(locationPlan(res({ until: now + 17 * HOUR }), plugged, now, U)).toEqual({ run: false });
    expect(locationPlan(res({ until: null }), plugged, now, U)).toEqual({ run: false });
  });

  it("on battery (or unknown): the overnight stop stays", () => {
    const far = res({ until: now + 11 * HOUR });
    expect(locationPlan(far, { ...CFG, charging: false }, now, U)).toEqual({ run: false });
    expect(locationPlan(far, { ...CFG, charging: null }, now, U)).toEqual({ run: false });
  });

  it("killed, revoked and unpaired stop, charging or not", () => {
    for (const mode of ["killed", "revoked", "unpaired"] as const) {
      expect(locationPlan(res({ mode, intervalS: null }), { ...CFG, charging: true }, now, U)).toEqual({ run: false });
    }
  });

  it("the notification text is fixed: no countdown, no clock, in both builds", () => {
    const a = locationPlan(active, CFG, now, U);
    const b = locationPlan(res({ until: now + 2 * HOUR }), CFG, now + 7 * 60_000, U);
    const c = locationPlan(res({ until: now + 2 * HOUR }), CFG, now, P);
    if (!a.run || !b.run || !c.run) throw new Error("expected run");
    expect(a.notification).toEqual(b.notification);
    expect(a.notification).toEqual(c.notification);
    expect(JSON.stringify(a.notification)).not.toMatch(/\d:\d\d|until/i);
  });
});

describe("nativeDecision: build x plan x foreground/background -> native action", () => {
  const act = res({ mode: "active", intervalS: 10, until: at(11), window: win() });
  const idleNear = res({ until: now + HOUR });
  const idleFar = res({ until: now + 11 * HOUR });
  const dead = res({ mode: "killed", intervalS: null });
  const d = (
    cap: Capability,
    r: ModeResolution,
    running: boolean,
    key: "same" | "other" | null,
    fg: boolean,
    verified = true,
  ) => {
    const plan = locationPlan(r, CFG, now, cap);
    return nativeDecision({
      plan,
      running,
      startedKey: key === "same" ? planKey(plan) : key === "other" ? "low|900000|x" : null,
      foreground: fg,
      capability: cap,
      verified,
    });
  };
  const none = { action: "none", needsApp: false } as const;
  const start = { action: "start", needsApp: false } as const;
  const stop = { action: "stop", needsApp: false } as const;
  const open = { action: "none", needsApp: true } as const;

  describe("patched", () => {
    it("killed/revoked: stop from foreground or background; nothing to do when not running", () => {
      expect(d(P, dead, true, "same", true)).toEqual(stop);
      expect(d(P, dead, true, "same", false)).toEqual(stop);
      expect(d(P, dead, false, null, false)).toEqual(none);
    });
    it("running with the right options and verified in this process: nothing, in any mode", () => {
      for (const r of [act, idleNear, idleFar])
        for (const fg of [true, false]) expect(d(P, r, true, "same", fg, true)).toEqual(none);
    });
    it("foreground, registry says running with the right key but not verified in this process: re-register", () => {
      // expo-task-manager restores its registry on every process start (reboot, OEM kill, app open) without
      // necessarily starting the service, so "running" + a persisted key proves nothing until we start it ourselves
      for (const r of [act, idleNear, idleFar]) expect(d(P, r, true, "same", true, false)).toEqual(start);
    });
    it("background, unverified, right key: cannot tell and cannot start: nothing", () => {
      for (const r of [act, idleNear]) expect(d(P, r, true, "same", false, false)).toEqual(none);
    });
    it("running with other options (mode changed) or unknown (older build): update in place, fg or bg", () => {
      for (const r of [act, idleNear, idleFar])
        for (const key of ["other", null] as const)
          for (const fg of [true, false]) expect(d(P, r, true, key, fg)).toEqual(start);
    });
    it("not running: start in the foreground; in the background a cold start is impossible -> open the app", () => {
      for (const r of [act, idleNear, idleFar]) {
        expect(d(P, r, false, null, true)).toEqual(start);
        expect(d(P, r, false, null, false)).toEqual(open);
      }
    });
  });

  describe("unpatched", () => {
    it("killed/revoked: stop from foreground or background", () => {
      expect(d(U, dead, true, "same", true)).toEqual(stop);
      expect(d(U, dead, true, "same", false)).toEqual(stop);
    });
    it("idle with the next window beyond 3 h: stop from foreground or background; none when already stopped", () => {
      expect(d(U, idleFar, true, "same", true)).toEqual(stop);
      expect(d(U, idleFar, true, "same", false)).toEqual(stop);
      expect(d(U, idleFar, false, null, false)).toEqual(none);
    });
    it("active / idle within 3 h, running with the day's options, verified: nothing (mode changes never touch the task)", () => {
      for (const r of [act, idleNear]) for (const fg of [true, false]) expect(d(U, r, true, "same", fg)).toEqual(none);
    });
    it("restored registry after a reboot / kill (right key, not verified), app opened: start", () => {
      for (const r of [act, idleNear]) expect(d(U, r, true, "same", true, false)).toEqual(start);
    });
    it("restored registry, still in the background: nothing we can do, nothing to claim", () => {
      for (const r of [act, idleNear]) expect(d(U, r, true, "same", false, false)).toEqual(none);
    });
    it("active / idle within 3 h, not running or other options: start in the foreground, open the app in the background", () => {
      for (const r of [act, idleNear])
        for (const [running, key] of [
          [false, null],
          [true, "other"],
          [true, null],
        ] as const) {
          expect(d(U, r, running, key, true)).toEqual(start);
          expect(d(U, r, running, key, false)).toEqual(open);
        }
    });
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

describe("reminderTarget: which window the 'open the app' reminder is for", () => {
  it("idle before an active window: 15 min before it starts", () => {
    const r = res({ until: now + 11 * HOUR, next: win({ startsAt: now + 11 * HOUR }) });
    expect(reminderTarget(r, now)).toEqual({ for: now + 11 * HOUR, at: now + 11 * HOUR - 15 * 60_000 });
  });
  it("never in the past: at least a minute from now", () => {
    const r = res({ until: now + 5 * 60_000, next: win({ startsAt: now + 5 * 60_000 }) });
    expect(reminderTarget(r, now)?.at).toBe(now + 60_000);
  });
  it("active now (task missing): a minute from now, for the current window", () => {
    expect(reminderTarget(res({ mode: "active", window: win({ startsAt: at(8) }) }), now)).toEqual({
      for: at(8),
      at: now + 60_000,
    });
  });
  it("idle with no window ahead, or killed: none", () => {
    expect(reminderTarget(res({ until: null }), now)).toBeNull();
    expect(reminderTarget(res({ mode: "killed", intervalS: null }), now)).toBeNull();
    expect(reminderTarget(res({ until: now + HOUR, next: win({ mode: "idle" }) }), now)).toBeNull();
  });
});

describe("reminderAction: one local notification 'Shuttle tracking: open the app to start'", () => {
  const target = { for: now + 11 * HOUR, at: now + 11 * HOUR - 15 * 60_000 };
  const base = {
    capability: U,
    mode: "idle" as const,
    taskWanted: false,
    needsApp: false,
    target,
    reminderFor: null as number | null,
    hasPermission: true,
  };
  const sched = { action: "schedule", at: target.at, for: target.for };

  it("unpatched, idle with the task stopped for the night: schedule it", () => {
    expect(reminderAction(base)).toEqual(sched);
  });
  it("unpatched, tracking wanted but only the app can start it: schedule it", () => {
    expect(reminderAction({ ...base, taskWanted: true, needsApp: true })).toEqual(sched);
  });
  it("already pending for this window: leave it", () => {
    expect(reminderAction({ ...base, reminderFor: target.for })).toEqual({ action: "none" });
  });
  it("pending for another window: replace it", () => {
    expect(reminderAction({ ...base, reminderFor: target.for - 1000 })).toEqual(sched);
  });
  it("no notification permission: skip, and clear one we had", () => {
    expect(reminderAction({ ...base, hasPermission: false })).toEqual({ action: "none" });
    expect(reminderAction({ ...base, hasPermission: false, reminderFor: 5 })).toEqual({ action: "cancel" });
  });
  it("the task runs fine: cancel a pending one, else nothing", () => {
    expect(reminderAction({ ...base, mode: "active", taskWanted: true, reminderFor: 5 })).toEqual({ action: "cancel" });
    expect(reminderAction({ ...base, mode: "active", taskWanted: true })).toEqual({ action: "none" });
  });
  it("killed / revoked / nothing ahead: cancel a pending one", () => {
    expect(reminderAction({ ...base, mode: "killed", target: null, reminderFor: 5 })).toEqual({ action: "cancel" });
    expect(reminderAction({ ...base, target: null, reminderFor: 5 })).toEqual({ action: "cancel" });
  });
  it("patched phones: no reminder for a stopped-overnight task (they never stop), cancel a leftover", () => {
    expect(reminderAction({ ...base, capability: P })).toEqual({ action: "none" });
    expect(reminderAction({ ...base, capability: P, reminderFor: 5 })).toEqual({ action: "cancel" });
  });
  it("patched phones whose task needs the app (restored after a kill, refused update): schedule it too", () => {
    const p = { ...base, capability: P, mode: "idle" as const, taskWanted: true, needsApp: true };
    expect(reminderAction(p)).toEqual(sched);
    expect(reminderAction({ ...p, mode: "active" })).toEqual(sched);
    expect(reminderAction({ ...p, reminderFor: target.for })).toEqual({ action: "none" });
    expect(reminderAction({ ...p, hasPermission: false })).toEqual({ action: "none" });
    expect(reminderAction({ ...p, needsApp: false, reminderFor: 5 })).toEqual({ action: "cancel" });
  });
});

describe("gateFixes: what the JS side keeps from the task's fixes", () => {
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

  it("idle: drops every fix (SPEC §4: positions only inside windows)", () => {
    const t0 = at(12);
    expect(gateFixes([fix(t0), fix(t0 + 10_000), fix(t0 + 16 * 60_000)], dc([run]), 0, null).keep).toEqual([]);
  });

  it("a silence window drops fixes inside an active window", () => {
    const silence = win({ startsAt: at(9), endsAt: at(10), mode: "idle", source: "silence" });
    expect(gateFixes([fix(at(9, 30))], dc([run, silence]), 0, null).keep).toEqual([]);
  });

  it("carries the cadence across calls through lastKeptAt", () => {
    const t0 = at(9);
    const g = gateFixes([fix(t0 + 1_000)], dc([run]), 0, t0);
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
