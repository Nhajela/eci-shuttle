/**
 * The location task (SPEC §4/§5): expo-location background updates + expo-task-manager, as thin native wiring.
 * What to do is decided in plan.ts and apply.ts (unit-tested); this file only holds the expo calls.
 *
 * Model (NOTES.md): ONE task with fixed "tracking day" options is started while the app is on screen. It is never
 * started, retuned or restarted from the background, because expo-location throws for that. Active vs idle is a
 * JS gate (plan.gateFixes) applied to each delivery by the runtime.
 *
 * Import this module from the app entry (top level), so the task is defined when Android starts JS headless.
 */
import type { ModeResolution } from "@eci-shuttle/shared/contracts";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { AppState } from "react-native";
import { type Applied, applyLocationPlan, type NativeLocation } from "./apply";
import { locationPlan } from "./plan";

export const LOCATION_TASK = "eci-shuttle-location";

type WakeHandler = (fixes: Location.LocationObject[], now: number) => Promise<void>;
let handler: WakeHandler | null = null;

/** Called on every delivery of the task (one fix per activeIntervalS while the task runs). */
export function onLocationWake(h: WakeHandler): void {
  handler = h;
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error) console.warn("location task error", error.message);
  await handler?.(data?.locations ?? [], Date.now());
});

/** Headless JS reports "background" or "unknown", so only an explicit "active" counts as on screen. */
export const isForeground = () => AppState.currentState === "active";

const native: NativeLocation = {
  isRunning: () => Location.hasStartedLocationUpdatesAsync(LOCATION_TASK),
  stop: () => Location.stopLocationUpdatesAsync(LOCATION_TASK),
  start: (plan) =>
    // On a running task this replaces its options in place (used to migrate an older build's idle task).
    Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: plan.timeIntervalMs,
      distanceInterval: 0,
      mayShowUserSettingsDialog: false,
      foregroundService: {
        notificationTitle: plan.notification.title,
        notificationBody: plan.notification.body,
        killServiceOnDestroy: false,
      },
    }),
};

/** Bring the native task in line with this resolution if the app is on screen; otherwise only report what's missing. */
export function syncLocationService(
  r: ModeResolution,
  cfg: { activeIntervalS: number; idleHeartbeatS: number },
  now: number,
  startedKey: string | null,
): Promise<Applied> {
  return applyLocationPlan(locationPlan(r, cfg, now), { native, foreground: isForeground(), startedKey });
}
