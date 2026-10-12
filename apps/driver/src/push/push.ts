import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { isSyncPush } from "./payload";

export const PUSH_SYNC_TASK = "eci-shuttle.push-sync";

/**
 * Runs `sync` whenever the server's data-only "sync now" push arrives, including after the app was swiped away.
 * TaskManager requires this at module top level of the app entry, before any component renders.
 */
export function definePushSyncTask(sync: () => Promise<unknown>) {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(PUSH_SYNC_TASK, async ({ data, error }) => {
    if (error || !isSyncPush(data)) return Notifications.BackgroundNotificationTaskResult.NoData;
    try {
      await sync();
      return Notifications.BackgroundNotificationTaskResult.NewData;
    } catch {
      return Notifications.BackgroundNotificationTaskResult.Failed; // the next heartbeat retries anyway
    }
  });
}

/** Hooks the task up to incoming pushes. Safe to call on every launch. */
export function registerPushSync() {
  return Notifications.registerTaskAsync(PUSH_SYNC_TASK);
}

let cached: string | undefined;
// FCM can rotate the device token; refetch the Expo token on the next sync.
Notifications.addPushTokenListener(() => {
  cached = undefined;
});

/**
 * Expo push token for SyncRequest.pushToken / PairRequest.pushToken. Null while notifications aren't granted
 * or before `eas init` sets the project id (SPEC §10). Never asks for permission: onboarding does that.
 */
export async function getPushToken(): Promise<string | null> {
  if (cached) return cached;
  try {
    if (!(await Notifications.getPermissionsAsync()).granted) return null;
    const projectId: string | undefined = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return null;
    cached = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    return cached;
  } catch {
    return null; // offline or FCM not ready; the next sync tries again
  }
}
