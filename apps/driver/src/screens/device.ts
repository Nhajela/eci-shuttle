/**
 * Native wiring for the screens over the app's one device store (store/native), so pairing done here is what the
 * background sync reads, and a new pairing clears the ping queue.
 * ponytail: `syncNow` is a no-op until the app has a runtime that drives driver-sync's syncOnce (no composition
 * root yet); the screens keep using this module unchanged when it lands.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Updates from "expo-updates";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { fileKV, deviceStore as store } from "../store/native";
import { createScreenDevice, type ScreenSnapshot } from "./deviceCore";

const builtInOrigin: string = Constants.expoConfig?.extra?.apiOrigin ?? "https://eci-shuttle.positivesumcompany.com";

// no-op until the runtime lands (see above); resumePending is still sent by the next sync.
const syncNow = async () => {};

const device = createScreenDevice({ store, files: fileKV, syncNow, fetch: (u, i) => fetch(u, i), builtInOrigin });

export const appVersion = (): string => Constants.expoConfig?.version ?? "0.0.0";

let snap: ScreenSnapshot | null = null;
const listeners = new Set<() => void>();
/** Re-read everything from disk (the background task writes it too) and re-render. */
export async function refresh() {
  snap = await device.load();
  for (const l of listeners) l();
}
void refresh();

/** null while the first read from disk is in flight. Re-reads when the app comes to the foreground. */
export function useDevice(): ScreenSnapshot | null {
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => st === "active" && void refresh());
    return () => sub.remove();
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snap,
  );
}

const then =
  <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) =>
  async (...a: A) => {
    await fn(...a);
    await refresh();
  };

export const acceptConsent = then(device.acceptConsent);
export const finishSetup = then(device.finishSetup);
export const resume = then(device.resume);
export const pair = then((code: string, origin: string | null) =>
  device.pair(code, origin, {
    model: [Device.manufacturer, Device.modelName].filter(Boolean).join(" "),
    appVersion: appVersion(),
    updateId: Updates.updateId ?? null,
  }),
);
