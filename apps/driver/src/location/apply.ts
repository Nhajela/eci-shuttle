/**
 * The thin, RN-free layer between the pure plan and the native task: asks nativeDecision what to do and does only
 * that. The expo-location calls are injected (service.ts wires them), so this is unit-tested with fakes.
 */
import { isForegroundNotAllowed, type LocationPlan, nativeDecision, planKey } from "./plan";

export type NativeLocation = {
  isRunning: () => Promise<boolean>;
  start: (plan: Extract<LocationPlan, { run: true }>) => Promise<void>;
  stop: () => Promise<void>;
};

export type Applied = {
  /** planKey of the last successful start, null when stopped or unknown; the caller persists it */
  startedKey: string | null;
  /** the plan wants tracking but the native task isn't right and we're in the background: the app must be opened */
  needsApp: boolean;
};

export async function applyLocationPlan(
  plan: LocationPlan,
  i: { native: NativeLocation; foreground: boolean; startedKey: string | null },
): Promise<Applied> {
  const running = await i.native.isRunning();
  const d = nativeDecision({ plan, running, startedKey: i.startedKey, foreground: i.foreground });
  // the key only means something while the task exists; a task the OS or the user killed has forgotten its options
  const known = running ? i.startedKey : null;
  if (d.action === "stop") {
    await i.native.stop();
    return { startedKey: null, needsApp: false };
  }
  if (d.action === "start" && plan.run) {
    try {
      await i.native.start(plan);
      return { startedKey: planKey(plan), needsApp: false };
    } catch (e) {
      // AppState said "foreground" a moment before the native side did; the next delivery or app focus retries
      if (isForegroundNotAllowed(e)) return { startedKey: known, needsApp: true };
      throw e;
    }
  }
  return { startedKey: known, needsApp: d.needsApp };
}
