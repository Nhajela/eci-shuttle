// Native wiring for the runtime. Not unit-tested (imports native modules); the cycle it runs is tested in runtime.test.ts.
// Imported first by the app entry (index.ts) so the location and push tasks exist when Android starts JS headless.

import * as Battery from "expo-battery";
import Constants from "expo-constants";
import { onLocationWake, syncLocationService } from "../location/service";
import { createExpoOta } from "../ota/expo";
import { definePushSyncTask, getPushToken, registerPushSync } from "../push/push";
import { readPermissions } from "../screens/permissions";
import { deviceStore, fileKV, pingQueue } from "../store/native";
import { createRuntime } from "./runtime";

const builtInOrigin: string = Constants.expoConfig?.extra?.apiOrigin ?? "https://eci-shuttle.positivesumcompany.com";

const ota = createExpoOta(() => runtime.mode());

export const runtime = createRuntime({
  store: deviceStore,
  queue: pingQueue,
  files: fileKV,
  fetch: (u, i) => fetch(u, i),
  builtInOrigin,
  now: () => Date.now(),
  location: { apply: syncLocationService },
  async battery() {
    const level = await Battery.getBatteryLevelAsync().catch(() => -1);
    return level < 0 ? null : Math.round(level * 100);
  },
  async telemetry() {
    const [state, permissions] = await Promise.all([
      Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
      readPermissions(),
    ]);
    return {
      charging:
        state === Battery.BatteryState.UNKNOWN
          ? null
          : state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
      permissions,
      appVersion: Constants.expoConfig?.version ?? "0.0.0",
    };
  },
  ota,
  pushToken: getPushToken,
});

onLocationWake((fixes) => runtime.wake(fixes));
definePushSyncTask(() => runtime.sync());
registerPushSync().catch((e) => console.warn("push task", e instanceof Error ? e.message : e));
// a cold start (opened, rebooted then opened, OTA reload) puts the service back in the right state
void runtime.sync();
