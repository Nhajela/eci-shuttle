/**
 * The screens' only view of the device store + sync.
 * ponytail: local stand-in until task/driver-store and task/driver-sync merge; swap these bodies for theirs
 * and keep the names. State is one JSON blob in SecureStore; resume/sync here don't talk to the server yet.
 */
import { PairResponse, type SyncResponse } from "@eci-shuttle/shared/contracts";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import * as Updates from "expo-updates";
import { useSyncExternalStore } from "react";

export type DeviceState = {
  consentAt: number | null;
  setupDoneAt: number | null;
  token: string | null;
  config: SyncResponse | null;
  lastSyncAt: number | null;
};

const KEY = "driver-screens-state";
const EMPTY: DeviceState = { consentAt: null, setupDoneAt: null, token: null, config: null, lastSyncAt: null };
const listeners = new Set<() => void>();
let state: DeviceState = load();

function load(): DeviceState {
  try {
    return { ...EMPTY, ...JSON.parse(SecureStore.getItem(KEY) ?? "{}") };
  } catch {
    return EMPTY;
  }
}

function set(patch: Partial<DeviceState>) {
  state = { ...state, ...patch };
  SecureStore.setItem(KEY, JSON.stringify(state));
  for (const l of listeners) l();
}

export function useDevice(): DeviceState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const appVersion = (): string => Constants.expoConfig?.version ?? "0.0.0";
const builtInOrigin = (): string => (Constants.expoConfig?.extra?.apiOrigin as string) ?? "";

export const acceptConsent = (now: number) => set({ consentAt: now });
export const finishSetup = (now: number) => set({ setupDoneAt: now });

/** POST /api/device/pair. Throws an Error with a message fit to show the driver. */
export async function pair(code: string, origin: string | null, now: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${origin ?? builtInOrigin()}/api/device/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        model: [Device.manufacturer, Device.modelName].filter(Boolean).join(" ").slice(0, 200),
        appVersion: appVersion(),
        updateId: Updates.updateId ?? null,
        pushToken: null,
      }),
    });
  } catch {
    throw new Error("No internet. Check the connection and try again.");
  }
  if (res.status === 400 || res.status === 404 || res.status === 410)
    throw new Error("That code didn't work. It may have expired: ask for a new one.");
  if (!res.ok) throw new Error(`The server had a problem (${res.status}). Try again in a minute.`);
  const body = PairResponse.parse(await res.json());
  set({ token: body.token, config: body.config, lastSyncAt: now });
}

/** Driver pressed Resume after a kill. The real sync sends `resume: true` so the server audits who/when. */
export async function resume(): Promise<void> {
  if (state.config) set({ config: { ...state.config, killed: false } });
}

/** Revoked phones wipe their token and pair again. */
export const forgetPairing = () => set({ token: null, config: null });
