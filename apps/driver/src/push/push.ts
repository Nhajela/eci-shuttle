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
 * Expo push token for SyncRequest.pushToken (undefined = field omitted = server keeps the token it has).
 * Does not need notification permission: the push is data-only (SPEC §4), so a driver who declined
 * notifications still gets "sync now". Undefined before `eas init` sets the project id, without
 * google-services.json in the APK (android.googleServicesFile, SPEC §10), or on a temporary failure;
 * never null, so one failed fetch can't clear a good token. PairRequest.pushToken needs `?? null`.
 */
export async function getPushToken(): Promise<string | undefined> {
  if (cached) return cached;
  const projectId: string | undefined = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return undefined;
  try {
    cached = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    return cached;
  } catch {
    return undefined; // offline or FCM not ready; the next sync tries again
  }
}
