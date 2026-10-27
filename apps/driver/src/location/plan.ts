/**
 * Pure side of the location service (SPEC §4 "Modes on the phone"). No react-native imports, so vitest can run it.
 *
 * Model (see NOTES.md): expo-location refuses startLocationUpdatesAsync with a foreground service whenever the app is
 * not on screen, so the native task is started ONCE, while the app is foregrounded, with options that never depend
 * on the mode or the clock. Active vs idle is decided in JS by gateFixes() as each delivery arrives.
 */
import type { DeviceConfig, ModeResolution, Ping } from "@eci-shuttle/shared/contracts";
import { resolveMode } from "@eci-shuttle/shared/schedule";

/** Idle phones keep the task on only if a window starts within this long ("tracking day"); otherwise it is stopped. */
export const TRACKING_HORIZON_MS = 16 * 3_600_000;
/** Same text all day: a foreground notification can't be updated from the background, so it must never go stale. */
export const NOTIFICATION = { title: "ECI Shuttle", body: "Location is on for today's shuttle runs" };

export type LocationPlan =
  | { run: false }
  | {
      run: true;
      /** what the phone is doing right now. Gate only: it never changes the native task. */
      mode: "active" | "idle";
      highAccuracy: true;
      /** the ACTIVE interval, fixed for the tracking day */
      timeIntervalMs: number;
      notification: { title: string; body: string };
    };

/** Native options are fixed for the day; mode is deliberately not part of them. */
export function locationPlan(
  r: ModeResolution,
  cfg: { activeIntervalS: number; idleHeartbeatS: number },
  now: number,
): LocationPlan {
  if (r.mode !== "active" && r.mode !== "idle") return { run: false };
  // idle with no window soon (or none in the schedule at all): nothing to track for a long time
  if (r.mode === "idle" && (r.until === null || r.until - now > TRACKING_HORIZON_MS)) return { run: false };
  return {
    run: true,
    mode: r.mode,
    highAccuracy: true,
    timeIntervalMs: cfg.activeIntervalS * 1000,
    notification: NOTIFICATION,
  };
}

/** What the native task was started with. Equal keys = nothing to restart. Only accuracy + interval (+ fixed text). */
export function planKey(p: LocationPlan): string {
  return p.run ? `${p.highAccuracy ? "high" : "low"}|${p.timeIntervalMs}|${p.notification.title}` : "stop";
}

export type NativeDecision = { action: "none" | "start" | "stop"; needsApp: boolean };

/**
 * The only place that decides whether to touch the native task. Start and stop need the app on screen
 * (expo-location LocationModule.kt throws otherwise, even for an already-running task). In the background we never
 * call it: if the native state isn't what the plan wants we say so (`needsApp`) and the gate keeps data right.
 * `startedKey` = planKey of our last successful start; null = unknown (an older build's task) and counts as wrong.
 */
export function nativeDecision(i: {
  plan: LocationPlan;
  running: boolean;
  startedKey: string | null;
  foreground: boolean;
}): NativeDecision {
  if (!i.plan.run) return { action: i.running && i.foreground ? "stop" : "none", needsApp: false };
  if (i.running && i.startedKey === planKey(i.plan)) return { action: "none", needsApp: false };
  return i.foreground ? { action: "start", needsApp: false } : { action: "none", needsApp: true };
}

/** expo-location's "Foreground service cannot be started when the application is in the background" refusal. */
export function isForegroundNotAllowed(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return (
    (typeof code === "string" && /FOREGROUND_SERVICE_START_NOT_ALLOWED/i.test(code)) ||
    (typeof message === "string" && /foreground service cannot be started/i.test(message))
  );
}

// Native deliveries jitter a little early; without slack a 10 s fix at 9.8 s after the last would be thinned away.
const CADENCE_SLACK = 0.8;

/**
 * Which of the task's fixes to queue as pings. Each fix is judged by its own (server) time:
 * active window → at the window's cadence; idle → one per idleHeartbeatS (so the server still gets check-ins);
 * killed / revoked / unpaired → none. `lastKeptAt` is the time of the last kept fix (persist it between wakes).
 */
export function gateFixes(
  fixes: Fix[],
  dc: DeviceConfig | null,
  clockOffsetMs: number,
  lastKeptAt: number | null,
): { keep: Fix[]; lastKeptAt: number | null } {
  const keep: Fix[] = [];
  let last = lastKeptAt;
  for (const f of [...fixes].sort((a, b) => a.timestamp - b.timestamp)) {
    const r = resolveMode(dc, f.timestamp + clockOffsetMs);
    if ((r.mode !== "active" && r.mode !== "idle") || r.intervalS === null) continue;
    if (last === null || f.timestamp - last >= r.intervalS * 1000 * CADENCE_SLACK) {
      keep.push(f);
      last = f.timestamp;
    }
  }
  return { keep, lastKeptAt: last };
}

/** Shape of expo-location's LocationObject that we read (kept local so this file stays RN-free). */
export type Fix = {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    speed: number | null;
    heading: number | null;
  };
};

/** One fix → protocol Ping, or null when Android gave no accuracy. Android reports unknown speed/heading as negative. */
export function toPing(fix: Fix, battery: number | null): Ping | null {
  const { latitude, longitude, accuracy, speed, heading } = fix.coords;
  if (accuracy == null) return null;
  return {
    recordedAt: Math.round(fix.timestamp),
    lat: latitude,
    lng: longitude,
    accuracy,
    speed: speed != null && speed >= 0 ? speed : null,
    heading: heading != null && heading >= 0 && heading <= 360 ? heading : null,
    battery,
  };
}
