import { describe, expect, it, vi } from "vitest";
import { applyLocationPlan, type NativeLocation, type ReminderNative, runReminder } from "./apply";
import { type Capability, type LocationPlan, locationPlan, planKey } from "./plan";

const CFG = { activeIntervalS: 10, idleHeartbeatS: 900 };
const idleSoon = { mode: "idle", intervalS: 900, until: 1_000_000, window: null, next: null } as const;
const active = { mode: "active", intervalS: 10, until: 1_000_000, window: null, next: null } as const;
const planU = locationPlan(idleSoon, CFG, 0, "unpatched");
const planPIdle = locationPlan(idleSoon, CFG, 0, "patched");
const planPActive = locationPlan(active, CFG, 0, "patched");
const key = planKey(planU);
const stop: LocationPlan = { run: false };
const REFUSED = new Error(
  "Couldn't start the foreground service. Foreground service cannot be started when the application is in the background",
);

function fake(running: boolean, startError?: Error) {
  const native: NativeLocation = {
    isRunning: vi.fn(async () => running),
    start: vi.fn(async () => {
      if (startError) throw startError;
    }),
    stop: vi.fn(async () => {}),
  };
  return native;
}
const run = (
  plan: LocationPlan,
  native: NativeLocation,
  foreground: boolean,
  startedKey: string | null,
  cap: Capability,
) => applyLocationPlan(plan, { native, foreground, startedKey, capability: cap });

describe("applyLocationPlan: unpatched", () => {
  it("foreground: starts the task with the fixed options and remembers the key", async () => {
    const native = fake(false);
    const out = await run(planU, native, true, null, "unpatched");
    expect(native.start).toHaveBeenCalledWith(planU);
    expect(out).toEqual({ startedKey: key, needsApp: false, degraded: false });
  });

  it("background: touches nothing and says the app must be opened", async () => {
    const native = fake(false);
    const out = await run(planU, native, false, null, "unpatched");
    expect(native.start).not.toHaveBeenCalled();
    expect(native.stop).not.toHaveBeenCalled();
    expect(out).toEqual({ startedKey: null, needsApp: true, degraded: false });
  });

  it("background with a running task that matches: no calls, no flag (idle <-> active never retunes)", async () => {
    const native = fake(true);
    const out = await run(planU, native, false, key, "unpatched");
    expect(native.start).not.toHaveBeenCalled();
    expect(out).toEqual({ startedKey: key, needsApp: false, degraded: false });
  });

  it("a foreground start the OS still refuses is recorded as needsApp, not thrown, and is not 'degraded'", async () => {
    const out = await run(planU, fake(false, REFUSED), true, null, "unpatched");
    expect(out).toEqual({ startedKey: null, needsApp: true, degraded: false });
  });

  it("other start errors (permissions) still throw so the runtime logs them", async () => {
    const native = fake(false, new Error("Missing location permissions"));
    await expect(run(planU, native, true, null, "unpatched")).rejects.toThrow("permissions");
  });

  it("stops from the background when the plan says stop (killed, or the overnight gap); forgets the key", async () => {
    const native = fake(true);
    const out = await run(stop, native, false, key, "unpatched");
    expect(native.stop).toHaveBeenCalledOnce();
    expect(out).toEqual({ startedKey: null, needsApp: false, degraded: false });
  });

  it("a stopped task with a stop plan clears a stale key", async () => {
    const native = fake(false);
    expect(await run(stop, native, false, key, "unpatched")).toEqual({
      startedKey: null,
      needsApp: false,
      degraded: false,
    });
    expect(native.stop).not.toHaveBeenCalled();
  });
});

describe("applyLocationPlan: patched", () => {
  it("background, running with the other mode's options: updates in place and records the new key", async () => {
    const native = fake(true);
    const out = await run(planPActive, native, false, planKey(planPIdle), "patched");
    expect(native.start).toHaveBeenCalledWith(planPActive);
    expect(out).toEqual({ startedKey: planKey(planPActive), needsApp: false, degraded: false });
  });

  it("background, not running: no cold start attempt, asks for the app", async () => {
    const native = fake(false);
    const out = await run(planPIdle, native, false, null, "patched");
    expect(native.start).not.toHaveBeenCalled();
    expect(out).toEqual({ startedKey: null, needsApp: true, degraded: false });
  });

  it("background in-place update refused anyway: falls back (degraded), keeps the old key, asks for the app", async () => {
    const native = fake(true, REFUSED);
    const out = await run(planPActive, native, false, planKey(planPIdle), "patched");
    expect(out).toEqual({ startedKey: planKey(planPIdle), needsApp: true, degraded: true });
  });

  it("foreground refusal on a patched phone is not a patch failure", async () => {
    const out = await run(planPActive, fake(true, REFUSED), true, planKey(planPIdle), "patched");
    expect(out.degraded).toBe(false);
  });

  it("stops from the background on kill", async () => {
    const native = fake(true);
    await run(stop, native, false, planKey(planPIdle), "patched");
    expect(native.stop).toHaveBeenCalledOnce();
  });
});

describe("runReminder", () => {
  const rem = (): ReminderNative => ({ schedule: vi.fn(async () => {}), cancel: vi.fn(async () => {}) });

  it("schedule replaces the pending one and returns the window it is for", async () => {
    const r = rem();
    expect(await runReminder({ action: "schedule", at: 5, for: 9 }, r, null)).toBe(9);
    expect(r.schedule).toHaveBeenCalledWith(5);
  });
  it("cancel clears it", async () => {
    const r = rem();
    expect(await runReminder({ action: "cancel" }, r, 9)).toBeNull();
    expect(r.cancel).toHaveBeenCalledOnce();
  });
  it("none keeps the state", async () => {
    const r = rem();
    expect(await runReminder({ action: "none" }, r, 9)).toBe(9);
    expect(r.schedule).not.toHaveBeenCalled();
  });
  it("a notification failure never throws; the reminder just stays unset", async () => {
    const r = rem();
    r.schedule = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await runReminder({ action: "schedule", at: 5, for: 9 }, r, null)).toBeNull();
  });
});
