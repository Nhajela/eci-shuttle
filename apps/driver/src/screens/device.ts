/**
 * Native wiring for the screens: the same file + SecureStore KVs as task/driver-store's native.ts
 * (token in SecureStore, everything else in JSON files), so pairing done here is what the background sync reads.
 * ponytail: on merge of driver-store/driver-sync, replace `store`/`files` with `deviceStore` from "../store/native"
 * and `syncNow` with driver-sync's trigger; the screens keep using this module unchanged.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import * as Updates from "expo-updates";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createScreenDevice, type ScreenSnapshot } from "./deviceCore";
import { createDeviceStore } from "./deviceStore";
import type { KV } from "./storeKv";

const fileKV: KV = {
  async get(key) {
    const f = new File(Paths.document, `${key}.json`);
    return f.exists ? f.text() : null;
  },
  async set(key, value) {
    const tmp = new File(Paths.document, `${key}.json.tmp`);
    tmp.write(value);
    tmp.moveSync(new File(Paths.document, `${key}.json`), { overwrite: true });
  },
  async del(key) {
    const f = new File(Paths.document, `${key}.json`);
    if (f.exists) f.delete();
  },
};

const secureKV: KV = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  del: (k) => SecureStore.deleteItemAsync(k),
};

const builtInOrigin: string = Constants.expoConfig?.extra?.apiOrigin ?? "https://eci-shuttle.positivesumcompany.com";
const store = createDeviceStore({ files: fileKV, secure: secureKV, builtInOrigin });

// ponytail: no-op until driver-sync's client lands; resumePending is still sent by the next background sync.
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
