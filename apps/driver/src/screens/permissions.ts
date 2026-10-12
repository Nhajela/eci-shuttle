/** Reading and asking for the setup checklist's permissions (Android only). */
import type { Permissions } from "@eci-shuttle/shared/contracts";
import * as Battery from "expo-battery";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as IntentLauncher from "expo-intent-launcher";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { Linking } from "react-native";
import { autostartIntents, type ChecklistItem } from "./setup";

const PKG = Constants.expoConfig?.android?.package ?? "com.positivesumcompany.ecishuttle.driver";

export async function readPermissions(): Promise<Permissions> {
  const [fg, bg, notif, batteryOpt] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
    Notifications.getPermissionsAsync(),
    Battery.isBatteryOptimizationEnabledAsync(),
  ]);
  return {
    location: !fg.granted ? "denied" : bg.granted ? "always" : "foreground",
    preciseLocation: fg.android?.accuracy === "fine",
    notifications: notif.granted,
    batteryOptimizationExempt: !batteryOpt,
  };
}

async function tryIntents(intents: { packageName: string; className: string }[]): Promise<boolean> {
  for (const { packageName, className } of intents) {
    try {
      await IntentLauncher.startActivityAsync("android.intent.action.MAIN", { packageName, className });
      return true;
    } catch {
      // that OEM screen isn't on this OS version; try the next
    }
  }
  return false;
}

/** Opens the system prompt or settings screen that fixes one checklist item. */
export async function fix(key: ChecklistItem["key"]): Promise<void> {
  switch (key) {
    case "location": {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted || fg.android?.accuracy !== "fine") {
        if (!fg.canAskAgain || fg.granted) await Linking.openSettings();
        return;
      }
      // Android 11+ sends the driver to the settings page for "Allow all the time".
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (!bg.granted) await Linking.openSettings();
      return;
    }
    case "notifications": {
      const r = await Notifications.requestPermissionsAsync();
      if (!r.granted) await Linking.openSettings();
      return;
    }
    case "battery":
      try {
        await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, {
          data: `package:${PKG}`,
        });
      } catch {
        await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
      }
      return;
    case "autostart":
      if (!(await tryIntents(autostartIntents(Device.manufacturer)))) await Linking.openSettings();
      return;
  }
}
