/**
 * Native wiring for the screens over the app's one device store (store/native), so pairing done here is what the
 * background sync reads, and a new pairing clears the ping queue. `syncNow` runs the app runtime's sync, so Resume,
 * pairing and finishing setup reach the server (and start the location service) right away.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Updates from "expo-updates";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { nativeVersion } from "../lib/nativeVersion";
import { runtime } from "../runtime/native";
import { fileKV, deviceStore as store } from "../store/native";
import { createScreenDevice, type ScreenSnapshot } from "./deviceCore";

const builtInOrigin: string = Constants.expoConfig?.extra?.apiOrigin ?? "https://eci-shuttle.positivesumcompany.com";

const syncNow = () => runtime.sync();

const device = createScreenDevice({ store, files: fileKV, syncNow, fetch: (u, i) => fetch(u, i), builtInOrigin });

export { nativeVersion };
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
export const finishSetup = then(async (now: number) => {
  await device.finishSetup(now);
  void syncNow(); // don't hold the screen on the network; the service starts when it lands
});
export const resume = then(device.resume);
export const pair = then(async (code: string, origin: string | null) => {
  await device.pair(code, origin, {
    model: [Device.manufacturer, Device.modelName].filter(Boolean).join(" "),
    appVersion: appVersion(),
    updateId: Updates.updateId ?? null,
  });
  void syncNow(); // don't hold the screen on the network; the service starts when it lands
});
