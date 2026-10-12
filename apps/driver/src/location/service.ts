/**
 * The foreground location service (SPEC §4/§5): expo-location background updates + expo-task-manager.
 * Whoever owns the stored config (sync) calls syncLocationService() after every resolveMode(); every fix or
 * idle wake runs the handler set with onLocationWake(). See NOTES.md for reboot / swiped-away behaviour.
 *
 * Import this module from the app entry (top level), so the task is defined when Android starts JS headless.
 */
import type { ModeResolution } from "@eci-shuttle/shared/contracts";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { type LocationPlan, locationPlan, planKey } from "./plan";

export const LOCATION_TASK = "eci-shuttle-location";

type WakeHandler = (fixes: Location.LocationObject[], now: number) => Promise<void>;
let handler: WakeHandler | null = null;
let appliedKey: string | null = null;

/** Called on every delivery: active fixes, or the idle low-power wake (use it as a clock: re-resolve, maybe sync). */
export function onLocationWake(h: WakeHandler): void {
  handler = h;
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error) console.warn("location task error", error.message);
  await handler?.(data?.locations ?? [], Date.now());
});

/** Start, retune or stop the service for this resolution. Returns the plan so the caller knows whether to keep pings. */
export async function syncLocationService(
  r: ModeResolution,
  idleHeartbeatS: number,
  now: number,
): Promise<LocationPlan> {
  const plan = locationPlan(r, idleHeartbeatS, now);
  const key = planKey(plan);
  if (key === appliedKey) return plan;
  appliedKey = null; // a failed start/stop is retried on the next call
  if (!plan.run) {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK))
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } else {
    // Calling start on a running task replaces its options and notification in place.
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: plan.highAccuracy ? Location.Accuracy.High : Location.Accuracy.Lowest,
      timeInterval: plan.timeIntervalMs,
      distanceInterval: 0,
      mayShowUserSettingsDialog: false,
      foregroundService: {
        notificationTitle: plan.notification.title,
        notificationBody: plan.notification.body,
        killServiceOnDestroy: false,
      },
    });
  }
  appliedKey = key;
  return plan;
}
