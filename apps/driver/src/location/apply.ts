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
  /**
   * A patched build's in-place update of a task WE started in this process was refused in the background: behave as
   * unpatched from now on. Never set for a restored, unverified task, or for a foreground refusal.
   */
  degraded: boolean;
  /** this call registered the task from the foreground: it is verified for the rest of the process */
  registered: boolean;
};

export async function applyLocationPlan(
  plan: LocationPlan,
  i: {
    native: NativeLocation;
    foreground: boolean;
    startedKey: string | null;
    capability: Capability;
    verified: boolean;
  },
): Promise<Applied> {
  const running = await i.native.isRunning();
  const d = nativeDecision({
    plan,
    running,
    startedKey: i.startedKey,
    foreground: i.foreground,
    capability: i.capability,
    verified: i.verified,
  });
  // the key only means something while the task exists; a task the OS or the user killed has forgotten its options
  const known = running ? i.startedKey : null;
  if (d.action === "stop") {
    await i.native.stop();
    return { startedKey: null, needsApp: false, degraded: false, registered: false };
  }
  if (d.action === "start" && plan.run) {
    try {
      await i.native.start(plan);
      return { startedKey: planKey(plan), needsApp: false, degraded: false, registered: i.foreground };
    } catch (e) {
      if (!isForegroundNotAllowed(e)) throw e;
      // Foreground: JS saw "active" a moment before the native side did; the next delivery or app focus retries.
      // Background: if we registered this task ourselves in this process, the patch is not doing its job on this
      // phone, so stop relying on it. A task merely restored by the task manager proves nothing about the patch.
      return { startedKey: known, needsApp: true, degraded: !i.foreground && i.verified, registered: false };
    }
  }
  return { startedKey: known, needsApp: d.needsApp, degraded: false, registered: false };
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
  /** serverTime - phone clock: the plan's times are server time, notifications fire on the phone clock */
  clockOffsetMs: number,
): Promise<number | null> {
  try {
    if (a.action === "schedule") {
      await native.schedule(a.at - clockOffsetMs);
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
