import { describe, expect, it, vi } from "vitest";
import { applyLocationPlan, type NativeLocation } from "./apply";
import { type LocationPlan, locationPlan, planKey } from "./plan";

const CFG = { activeIntervalS: 10, idleHeartbeatS: 900 };
const idleSoon = { mode: "idle", intervalS: 900, until: 1_000_000, window: null, next: null } as const;
const plan = locationPlan(idleSoon, CFG, 0);
const key = planKey(plan);
const stop: LocationPlan = { run: false };

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

describe("applyLocationPlan", () => {
  it("foreground: starts the task with the fixed options and remembers the key", async () => {
    const native = fake(false);
    const out = await applyLocationPlan(plan, { native, foreground: true, startedKey: null });
    expect(native.start).toHaveBeenCalledWith(plan);
    expect(out).toEqual({ startedKey: key, needsApp: false });
  });

  it("background: touches nothing and says the app must be opened", async () => {
    const native = fake(false);
    const out = await applyLocationPlan(plan, { native, foreground: false, startedKey: null });
    expect(native.start).not.toHaveBeenCalled();
    expect(native.stop).not.toHaveBeenCalled();
    expect(out).toEqual({ startedKey: null, needsApp: true });
  });

  it("background with a running task that matches: no calls, no flag (idle <-> active never retunes)", async () => {
    const native = fake(true);
    const out = await applyLocationPlan(plan, { native, foreground: false, startedKey: key });
    expect(native.start).not.toHaveBeenCalled();
    expect(out).toEqual({ startedKey: key, needsApp: false });
  });

  it("a start that the OS refuses (we thought we were foregrounded) is recorded, not thrown", async () => {
    const native = fake(
      false,
      new Error(
        "Couldn't start the foreground service. Foreground service cannot be started when the application is in the background",
      ),
    );
    const out = await applyLocationPlan(plan, { native, foreground: true, startedKey: null });
    expect(out).toEqual({ startedKey: null, needsApp: true });
  });

  it("other start errors (permissions) still throw so the runtime logs them", async () => {
    const native = fake(false, new Error("Missing location permissions"));
    await expect(applyLocationPlan(plan, { native, foreground: true, startedKey: null })).rejects.toThrow(
      "permissions",
    );
  });

  it("foreground stop when the plan says no tracking; forgets the key", async () => {
    const native = fake(true);
    const out = await applyLocationPlan(stop, { native, foreground: true, startedKey: key });
    expect(native.stop).toHaveBeenCalledOnce();
    expect(out).toEqual({ startedKey: null, needsApp: false });
  });

  it("background with a stop plan leaves the task running (the gate drops its fixes)", async () => {
    const native = fake(true);
    const out = await applyLocationPlan(stop, { native, foreground: false, startedKey: key });
    expect(native.stop).not.toHaveBeenCalled();
    expect(out).toEqual({ startedKey: key, needsApp: false });
  });

  it("a stopped task with a stop plan clears a stale key", async () => {
    const native = fake(false);
    expect(await applyLocationPlan(stop, { native, foreground: false, startedKey: key })).toEqual({
      startedKey: null,
      needsApp: false,
    });
  });
});
