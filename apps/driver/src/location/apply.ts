/**
 * The thin, RN-free layer between the pure plan and the native side: asks nativeDecision what to do and does only
 * that. The expo calls are injected (service.ts wires them), so this is unit-tested with fakes.
 */
import {
  type Capability,
  isForegroundNotAllowed,
  type LocationPlan,
  nativeDecision,
  planKey,
  type ReminderAction,
} from "./plan";

/** What the runtime persists about the native side between wakes (each wake may be a fresh process). */
export type NativeState = {
  startedKey: string | null;
  needsApp: boolean;
  /** native app version at which a patched build's background update was refused; ignored once the APK changes */
  degradedAt: string | null;
  /** window start the pending "open the app" reminder is for */
  reminderFor: number | null;
};

export type NativeLocation = {
  isRunning: () => Promise<boolean>;
  start: (plan: Extract<LocationPlan, { run: true }>) => Promise<void>;
  stop: () => Promise<void>;
};

export type Applied = {
  /** planKey of the last successful start/update, null when stopped or unknown; the caller persists it */
  startedKey: string | null;
  /** the plan wants tracking but the native task isn't right and only opening the app can fix it */
  needsApp: boolean;
  /** a patched build's in-place update was refused in the background: behave as unpatched from now on */
  degraded: boolean;
};

export async function applyLocationPlan(
  plan: LocationPlan,
  i: { native: NativeLocation; foreground: boolean; startedKey: string | null; capability: Capability },
): Promise<Applied> {
  const running = await i.native.isRunning();
  const d = nativeDecision({
    plan,
    running,
    startedKey: i.startedKey,
    foreground: i.foreground,
    capability: i.capability,
  });
  // the key only means something while the task exists; a task the OS or the user killed has forgotten its options
  const known = running ? i.startedKey : null;
  if (d.action === "stop") {
    await i.native.stop();
    return { startedKey: null, needsApp: false, degraded: false };
  }
  if (d.action === "start" && plan.run) {
    try {
      await i.native.start(plan);
      return { startedKey: planKey(plan), needsApp: false, degraded: false };
    } catch (e) {
      if (!isForegroundNotAllowed(e)) throw e;
      // Foreground: JS saw "active" a moment before the native side did; the next delivery or app focus retries.
      // Background: the patch is not doing its job on this phone, so stop relying on it.
      return { startedKey: known, needsApp: true, degraded: !i.foreground };
    }
  }
  return { startedKey: known, needsApp: d.needsApp, degraded: false };
}

export type ReminderNative = {
  /** one pending notification at a time: replaces any earlier one */
  schedule: (atMs: number) => Promise<void>;
  cancel: () => Promise<void>;
};

/** Runs a ReminderAction. Returns the new `reminderFor`. A notification problem must never break tracking. */
export async function runReminder(
  a: ReminderAction,
  native: ReminderNative,
  reminderFor: number | null,
): Promise<number | null> {
  try {
    if (a.action === "schedule") {
      await native.schedule(a.at);
      return a.for;
    }
    if (a.action === "cancel") {
      await native.cancel();
      return null;
    }
  } catch (e) {
    console.warn("start reminder", e instanceof Error ? e.message : e);
    return a.action === "schedule" ? null : reminderFor;
  }
  return reminderFor;
}
