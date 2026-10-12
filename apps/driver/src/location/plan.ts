/**
 * Pure side of the location service (SPEC §4 "Modes on the phone"): what the foreground service should be doing
 * for a resolveMode() answer. No react-native imports, so vitest can run it.
 */
import { IST_OFFSET_MIN, type ModeResolution, type Ping } from "@eci-shuttle/shared/contracts";

export type LocationPlan =
  | { run: false }
  | {
      run: true;
      /** active: queue fixes as pings. idle: the wake is only a clock, fixes are dropped (not tracked outside windows). */
      recordPings: boolean;
      highAccuracy: boolean;
      timeIntervalMs: number;
      notification: { title: string; body: string };
    };

const MIN_WAKE_MS = 60_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "11:00", or "Tue 07:00" when `t` falls on another IST day than `now`. Offset maths: Hermes' Intl tz data is not guaranteed. */
export function istClock(t: number, now: number): string {
  const d = new Date(t + IST_OFFSET_MIN * 60_000);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const sameDay = d.toISOString().slice(0, 10) === new Date(now + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
  return sameDay ? hhmm : `${DAYS[d.getUTCDay()]} ${hhmm}`;
}

export function notificationText(r: ModeResolution, now: number): { title: string; body: string } {
  if (r.mode === "active") {
    return {
      title: r.until == null ? "Sharing location" : `Sharing location until ${istClock(r.until, now)}`,
      body: r.window?.label ?? "Shuttle service",
    };
  }
  return {
    title: r.until == null ? "Paused" : `Paused until ${istClock(r.until, now)}`,
    body: "Not sharing location",
  };
}

/** Only active and idle keep the foreground service; killed/revoked/unpaired stop it and its notification. */
export function locationPlan(r: ModeResolution, idleHeartbeatS: number, now: number): LocationPlan {
  if (r.mode !== "active" && r.mode !== "idle") return { run: false };
  const active = r.mode === "active";
  let timeIntervalMs = (r.intervalS ?? idleHeartbeatS) * 1000;
  // Idle wake doubles as the clock that flips to active, so don't sleep past the next window start.
  if (!active && r.until != null) timeIntervalMs = Math.max(MIN_WAKE_MS, Math.min(timeIntervalMs, r.until - now));
  return {
    run: true,
    recordPings: active,
    highAccuracy: active,
    timeIntervalMs,
    notification: notificationText(r, now),
  };
}

/** Restart the service only when this changes (start/stop are not free and re-post the notification). */
export function planKey(p: LocationPlan): string {
  return p.run ? JSON.stringify(p) : "stop";
}

/** Shape of expo-location's LocationObject that we read (kept local so this file stays RN-free). */
type Fix = {
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
