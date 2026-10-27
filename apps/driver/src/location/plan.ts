/**
 * Pure side of the location service (SPEC §4 "Modes on the phone"). No react-native imports, so vitest can run it.
 *
 * expo-location 57 refuses startLocationUpdatesAsync with a foreground service whenever the app is not on screen
 * (LocationModule.kt), even for a task that is already running. Two builds exist:
 * - patched (native app version >= 0.1.1): an APK with a pnpm patch that lets a RUNNING task be re-registered with
 *   new options from the background. Per-mode options again; a cold start still needs the app on screen.
 * - unpatched (0.1.0): nothing can be started or changed from the background. One fixed "tracking day" task started
 *   in the foreground, mode decided by gateFixes(), stopped overnight (stopping works from the background) and
 *   restarted by the driver opening the app, prompted by a local notification.
 */
import type { DeviceConfig, ModeResolution, Ping } from "@eci-shuttle/shared/contracts";
import { resolveMode } from "@eci-shuttle/shared/schedule";
import { isOlderVersion } from "../screens/status";

export type Capability = "patched" | "unpatched";

/** First native app version that carries the expo-location patch (branch fix/driver-native). */
export const PATCHED_FROM_VERSION = "0.1.1";

/**
 * What this phone's expo-location can do. `nativeVersion` is the APK's version (not the OTA bundle's), null if unknown.
 * `degraded`: a patched build whose in-place update was still refused in the background; it behaves as unpatched.
 */
export function capabilityFor(nativeVersion: string | null, degraded: boolean): Capability {
  if (degraded || !nativeVersion || !/^\d+(\.\d+)*$/.test(nativeVersion)) return "unpatched";
  return isOlderVersion(nativeVersion, PATCHED_FROM_VERSION) ? "unpatched" : "patched";
}

/** Unpatched: with no active window this close, the task is stopped (no all-night GPS) and a reminder is set. */
export const IDLE_STOP_AFTER_MS = 3 * 3_600_000;
/** The reminder fires this long before the next window starts. */
export const REMINDER_LEAD_MS = 15 * 60_000;
export const REMINDER_TEXT = { title: "Shuttle tracking: open the app to start", body: "Tap to open the app" };
/** Same text all day: a foreground notification can't be refreshed from the background, so it must never go stale. */
export const NOTIFICATION = { title: "ECI Shuttle", body: "Location is on for today's shuttle runs" };

export type LocationPlan =
  | { run: false }
  | {
      run: true;
      /** what the phone is doing right now */
      mode: "active" | "idle";
      highAccuracy: boolean;
      timeIntervalMs: number;
      notification: { title: string; body: string };
    };

/** What the native task should be doing. Killed / revoked / unpaired always stop, in both builds. */
export function locationPlan(
  r: ModeResolution,
  cfg: { activeIntervalS: number; idleHeartbeatS: number },
  now: number,
  capability: Capability,
): LocationPlan {
  if (r.mode !== "active" && r.mode !== "idle") return { run: false };
  const activeOptions = { highAccuracy: true, timeIntervalMs: cfg.activeIntervalS * 1000 };
  if (r.mode === "active") return { run: true, mode: "active", ...activeOptions, notification: NOTIFICATION };
  if (capability === "patched") {
    // cheap enough to leave on all night, and a background cold start would be impossible
    return {
      run: true,
      mode: "idle",
      highAccuracy: false,
      timeIntervalMs: cfg.idleHeartbeatS * 1000,
      notification: NOTIFICATION,
    };
  }
  // unpatched: same options as active, so nothing needs retuning; but not all night
  if (r.until === null || r.until - now > IDLE_STOP_AFTER_MS) return { run: false };
  return { run: true, mode: "idle", ...activeOptions, notification: NOTIFICATION };
}

/** What the native task was started with: accuracy + interval + the fixed text. No countdown, no clock. */
export function planKey(p: LocationPlan): string {
  return p.run ? `${p.highAccuracy ? "high" : "low"}|${p.timeIntervalMs}|${p.notification.title}` : "stop";
}

export type NativeDecision = { action: "none" | "start" | "stop"; needsApp: boolean };

/**
 * The only place that decides whether to touch the native task.
 * - plan says stop: stop whenever it runs (stopLocationUpdatesAsync works from the background).
 * - right options already running: nothing.
 * - running with other options: patched updates it in place from anywhere; unpatched needs the app on screen.
 * - not running: start only with the app on screen (a cold start fails from the background even when patched).
 * Whenever tracking is wanted and we can't act, `needsApp` is set so the status screen can ask for the app.
 * `startedKey` = planKey of our last successful start; null = unknown (an older build's task) and counts as wrong.
 */
export function nativeDecision(i: {
  plan: LocationPlan;
  running: boolean;
  startedKey: string | null;
  foreground: boolean;
  capability: Capability;
}): NativeDecision {
  if (!i.plan.run) return { action: i.running ? "stop" : "none", needsApp: false };
  if (i.running && i.startedKey === planKey(i.plan)) return { action: "none", needsApp: false };
  if (i.foreground || (i.running && i.capability === "patched")) return { action: "start", needsApp: false };
  return { action: "none", needsApp: true };
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

/** The window the "open the app" reminder is about, and when to fire it. Null: nothing to remind of. */
export function reminderTarget(r: ModeResolution, now: number): { for: number; at: number } | null {
  if (r.mode === "active") return { for: r.window?.startsAt ?? now, at: now + 60_000 };
  if (r.mode === "idle" && r.until !== null && r.next?.mode === "active")
    return { for: r.until, at: Math.max(now + 60_000, r.until - REMINDER_LEAD_MS) };
  return null;
}

export type ReminderAction =
  | { action: "none" }
  | { action: "cancel" }
  | { action: "schedule"; at: number; for: number };

/**
 * One pending local notification at a time (replaced, or cancelled once the task runs). Only the unpatched build
 * needs it: when the task is stopped for the night or can't be started from the background, nothing else will
 * bring the driver to the app. `reminderFor` = the window start it is pending for (persisted), null = none.
 */
export function reminderAction(i: {
  capability: Capability;
  mode: ModeResolution["mode"];
  /** locationPlan(...).run */
  taskWanted: boolean;
  needsApp: boolean;
  target: { for: number; at: number } | null;
  reminderFor: number | null;
  hasPermission: boolean;
}): ReminderAction {
  const cancel: ReminderAction = i.reminderFor !== null ? { action: "cancel" } : { action: "none" };
  const needed =
    i.capability === "unpatched" && i.target !== null && ((i.mode === "idle" && !i.taskWanted) || i.needsApp);
  if (!needed || !i.hasPermission || !i.target) return cancel;
  if (i.reminderFor === i.target.for) return { action: "none" };
  return { action: "schedule", at: i.target.at, for: i.target.for };
}

// Native deliveries jitter a little early; without slack a 10 s fix at 9.8 s after the last would be thinned away.
const CADENCE_SLACK = 0.8;

/**
 * Which of the task's fixes to queue as pings. Each fix is judged by its own (server) time: only inside an active
 * window, at the window's cadence. Idle, killed, revoked and unpaired fixes are dropped (SPEC §4: positions only
 * inside windows; idle check-ins still sync, just without pings). `lastKeptAt` is the time of the last kept fix
 * (persist it between wakes).
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
    if (r.mode !== "active" || r.intervalS === null) continue;
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
