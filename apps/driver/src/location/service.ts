/**
 * The location task (SPEC §4/§5): expo-location background updates + expo-task-manager, as thin native wiring.
 * What to do is decided in plan.ts and apply.ts (unit-tested); this file only holds the expo calls.
 *
 * Model (NOTES.md): expo-location throws when a foreground-service task is started or changed while the app is in the
 * background. Patched APKs (>= 0.1.1) may update a RUNNING task from anywhere; 0.1.0 may only start it on screen and
 * only stops it from the background (plus a reminder notification). Which applies is plan.capabilityFor().
 *
 * Import this module from the app entry (top level), so the task is defined when Android starts JS headless.
 */
import type { ModeResolution } from "@eci-shuttle/shared/contracts";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { AppState } from "react-native";
import { nativeVersion } from "../lib/nativeVersion";
import { applyLocationPlan, type NativeLocation, type NativeState, type ReminderNative, runReminder } from "./apply";
import { capabilityFor, locationPlan, REMINDER_TEXT, reminderAction, reminderTarget } from "./plan";

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
    // On a running task this replaces its options in place. From the background that only works on a patched APK.
    Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: plan.highAccuracy ? Location.Accuracy.High : Location.Accuracy.Lowest,
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

const REMINDER_ID = "eci-shuttle.start-reminder";

const reminder: ReminderNative = {
  // the same identifier replaces the pending notification: one at a time
  schedule: async (atMs) => {
    await Notifications.scheduleNotificationAsync({
      identifier: REMINDER_ID,
      content: { title: REMINDER_TEXT.title, body: REMINDER_TEXT.body },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(atMs) },
    });
  },
  cancel: () => Notifications.cancelScheduledNotificationAsync(REMINDER_ID),
};

const hasNotificationPermission = () =>
  Notifications.getPermissionsAsync().then(
    (p) => p.granted,
    () => false,
  );

/**
 * Bring the native task in line with this resolution as far as this build and the app's foreground state allow
 * (plan.nativeDecision), and keep the "open the app to start" reminder right (unpatched builds only).
 * `nativeVersion` is injected: tests and the wiring in runtime/native.ts decide where it comes from.
 */
export async function syncLocationService(
  r: ModeResolution,
  cfg: { activeIntervalS: number; idleHeartbeatS: number },
  now: number,
  prev: NativeState,
  version: string | null = nativeVersion(),
): Promise<NativeState> {
  const capability = capabilityFor(version, prev.degradedAt !== null && prev.degradedAt === version);
  const plan = locationPlan(r, cfg, now, capability);
  const applied = await applyLocationPlan(plan, {
    native,
    foreground: isForeground(),
    startedKey: prev.startedKey,
    capability,
  });
  const degradedAt = applied.degraded ? version : prev.degradedAt === version ? version : null;
  const action = reminderAction({
    capability,
    mode: r.mode,
    taskWanted: plan.run,
    needsApp: applied.needsApp,
    target: reminderTarget(r, now),
    reminderFor: prev.reminderFor,
    hasPermission: await hasNotificationPermission(),
  });
  const reminderFor = await runReminder(action, reminder, prev.reminderFor);
  return { startedKey: applied.startedKey, needsApp: applied.needsApp, degradedAt, reminderFor };
}
