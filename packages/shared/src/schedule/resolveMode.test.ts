import { describe, expect, it } from "vitest";
import type { DeviceConfig, Window } from "../contracts";
import { notificationText, resolveMode } from "./resolveMode";

// 2026-10-12 06:00 IST = 00:30Z
const T0 = Date.UTC(2026, 9, 12, 0, 30);
const H = 3_600_000;
const M = 60_000;

const act = (s: number, e: number, intervalS: number | null = null, label: string | null = null): Window => ({
  startsAt: T0 + s,
  endsAt: T0 + e,
  mode: "active",
  intervalS,
  source: "service",
  label,
});
const sil = (s: number, e: number): Window => ({
  startsAt: T0 + s,
  endsAt: T0 + e,
  mode: "idle",
  intervalS: null,
  source: "silence",
  label: null,
});
const cfg = (schedule: Window[], over: Partial<DeviceConfig> = {}): DeviceConfig => ({
  configVersion: 1,
  killed: false,
  revoked: false,
  schedule,
  activeIntervalS: 10,
  idleHeartbeatS: 900,
  ...over,
});

describe("resolveMode", () => {
  it("null config → unpaired, intervalS null", () => {
    expect(resolveMode(null, T0)).toEqual({ mode: "unpaired", intervalS: null, until: null, window: null, next: null });
  });

  it("revoked → revoked even if also killed", () => {
    const r = resolveMode(cfg([act(-H, H)], { killed: true, revoked: true }), T0);
    expect(r).toEqual({ mode: "revoked", intervalS: null, until: null, window: null, next: null });
  });

  it("killed → killed regardless of windows", () => {
    const r = resolveMode(cfg([act(-H, H)], { killed: true }), T0);
    expect(r).toEqual({ mode: "killed", intervalS: null, until: null, window: null, next: null });
  });

  it("no windows → idle with idleHeartbeatS, until null", () => {
    expect(resolveMode(cfg([]), T0)).toEqual({ mode: "idle", intervalS: 900, until: null, window: null, next: null });
  });

  it("inside an active window → active with activeIntervalS, until = window end", () => {
    const w = act(-H, H);
    const r = resolveMode(cfg([w]), T0);
    expect(r).toMatchObject({ mode: "active", intervalS: 10, until: T0 + H, window: w, next: null });
  });

  it("active window with its own intervalS uses it", () => {
    expect(resolveMode(cfg([act(-H, H, 30)]), T0).intervalS).toBe(30);
  });

  it("overlapping active windows → smallest intervalS, until = end of merged run", () => {
    const fast = act(-H, H, 5);
    const r = resolveMode(cfg([act(-2 * H, 0.5 * H, 20), fast, act(0.5 * H, 3 * H, 60)]), T0);
    expect(r.mode).toBe("active");
    expect(r.intervalS).toBe(5);
    expect(r.window).toBe(fast);
    expect(r.until).toBe(T0 + 3 * H);
  });

  it("adjacent active windows (end == next start) merge for `until`", () => {
    expect(resolveMode(cfg([act(-H, H), act(H, 2 * H)]), T0).until).toBe(T0 + 2 * H);
  });

  it("silence window overlapping an active window → idle until silence end", () => {
    const s = sil(-0.5 * H, 0.5 * H);
    const a = act(-H, 2 * H);
    const r = resolveMode(cfg([a, s]), T0);
    expect(r).toMatchObject({ mode: "idle", intervalS: 900, until: T0 + 0.5 * H, window: s, next: a });
  });

  it("silence starting inside an active window cuts `until` to the silence start", () => {
    const s = sil(0.5 * H, H);
    const r = resolveMode(cfg([act(-H, 2 * H), s]), T0);
    expect(r).toMatchObject({ mode: "active", until: T0 + 0.5 * H, next: s });
  });

  it("before the first window → idle, until = next active start, next = that window", () => {
    const a = act(2 * H, 3 * H);
    const r = resolveMode(cfg([act(4 * H, 5 * H), a]), T0);
    expect(r).toEqual({ mode: "idle", intervalS: 900, until: T0 + 2 * H, window: null, next: a });
  });

  it("an active start hidden under a silence is not a transition", () => {
    const a = act(H, 3 * H);
    const r = resolveMode(cfg([a, sil(0, 2 * H)]), T0 - H);
    expect(r).toMatchObject({ mode: "idle", window: null });
    // plain idle → silence is still idle; mode changes when the silence ends and the active window shows through
    expect(r.until).toBe(T0 + 2 * H);
    expect(r.next).toBe(a);
  });

  it("half-open: now == endsAt is outside, now == startsAt is inside", () => {
    const a = act(0, H);
    expect(resolveMode(cfg([a]), T0).mode).toBe("active");
    expect(resolveMode(cfg([a]), T0 + H).mode).toBe("idle");
    expect(resolveMode(cfg([sil(0, H), act(-H, 2 * H)]), T0 + H).mode).toBe("active");
  });

  it("unsorted windows give the same answer as sorted ones", () => {
    const ws = [
      act(-H, 0.5 * H, 20),
      sil(2 * H, 3 * H),
      act(0.5 * H, 2.5 * H),
      act(5 * H, 6 * H),
      act(-0.5 * H, 0.2 * H, 5),
    ];
    const sorted = [...ws].sort((a, b) => a.startsAt - b.startsAt);
    for (const t of [T0 - 2 * H, T0, T0 + H, T0 + 2.2 * H, T0 + 4 * H, T0 + 7 * H]) {
      expect(resolveMode(cfg([...ws].reverse()), t)).toEqual(resolveMode(cfg(sorted), t));
    }
    expect(resolveMode(cfg(ws), T0)).toMatchObject({ mode: "active", intervalS: 5, until: T0 + 2 * H });
  });

  it("schedule exhausted (phone offline past the 48h horizon) → idle, until null", () => {
    const r = resolveMode(cfg([act(0, H), sil(2 * H, 3 * H)]), T0 + 50 * H);
    expect(r).toEqual({ mode: "idle", intervalS: 900, until: null, window: null, next: null });
  });
});

describe("notificationText", () => {
  const text = (c: DeviceConfig | null, now = T0) => notificationText(resolveMode(c, now), now);

  it("active shows IST end time and the window label", () => {
    expect(text(cfg([act(-H, 4.5 * H, null, "Riva ↔ Circle")]))).toBe("Sharing location until 10:30 · Riva ↔ Circle");
  });

  it("idle shows when sharing starts again, in IST", () => {
    expect(text(cfg([act(10 * H, 11 * H)]))).toBe("Paused until 16:00");
    expect(text(cfg([]))).toBe("Paused");
  });

  it("names the weekday when the change is not today (IST)", () => {
    // 2026-10-13 is a Tuesday; 00:30 IST next day
    expect(text(cfg([act(18.5 * H, 20 * H)]))).toBe("Paused until Tue 00:30");
  });

  it("silenced but no change in the schedule → just Paused until the silence end", () => {
    expect(text(cfg([sil(-H, 30 * M)]))).toBe("Paused until 06:30");
  });

  it("killed, revoked and unpaired", () => {
    expect(text(cfg([], { killed: true }))).toBe("Stopped by the organisers. Tap Resume to share again.");
    expect(text(cfg([], { killed: true, revoked: true }))).toBe("This phone was removed. Pair it again to share.");
    expect(text(null)).toBe("Not paired");
  });
});
