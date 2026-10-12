/**
 * What the screens read and do, on top of the device store (task/driver-store) and sync state (task/driver-sync).
 * Pure: storage, fetch and the sync trigger are passed in; native wiring is in ./device.
 */
import { type DeviceConfig, PairResponse, type SyncResponse } from "@eci-shuttle/shared/contracts";
import type { DeviceStore } from "./deviceStore";
import { type KV, parseJson } from "./storeKv";
import { initialSyncState, type SyncState } from "./syncStub";

/** Screen-owned keys, next to the store's in the same file KV. */
const SCREENS_KEY = "screens-state";
// ponytail: where driver-sync persists SyncState is not settled yet; this key is a guess (see contractRequests).
const SYNC_KEY = "sync-state";

export type ScreenSnapshot = {
  consentAt: number | null;
  setupDoneAt: number | null;
  /** last server response, for vehicle / APK / workspace; its `killed` is NOT the mode */
  config: SyncResponse | null;
  /** store.deviceConfig(): what resolveMode runs on (latched kill); null = unpaired */
  deviceConfig: DeviceConfig | null;
  /** for serverNow() and the last-sync line */
  sync: SyncState;
};

export type PhoneInfo = { model: string; appVersion: string; updateId: string | null };

export function createScreenDevice(deps: {
  store: DeviceStore;
  files: KV;
  syncNow: () => Promise<void>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  builtInOrigin: string;
}) {
  const { store, files } = deps;
  const screens = async () => {
    const v = parseJson(await files.get(SCREENS_KEY)) as { consentAt?: number; setupDoneAt?: number } | null;
    return { consentAt: v?.consentAt ?? null, setupDoneAt: v?.setupDoneAt ?? null };
  };
  const setScreens = async (patch: { consentAt?: number; setupDoneAt?: number }) =>
    files.set(SCREENS_KEY, JSON.stringify({ ...(await screens()), ...patch }));

  return {
    async load(): Promise<ScreenSnapshot> {
      const [s, st, deviceConfig, rawSync] = await Promise.all([
        screens(),
        store.state(),
        store.deviceConfig(),
        files.get(SYNC_KEY),
      ]);
      const sync = { ...initialSyncState(deps.builtInOrigin), ...(parseJson(rawSync) as Partial<SyncState> | null) };
      return { ...s, config: st.config, deviceConfig, sync };
    },

    acceptConsent: (now: number) => setScreens({ consentAt: now }),
    finishSetup: (now: number) => setScreens({ setupDoneAt: now }),

    /** POST /api/device/pair, then store.paired(). Throws an Error with a message fit to show the driver. */
    async pair(code: string, origin: string | null, info: PhoneInfo): Promise<void> {
      let res: Response;
      try {
        res = await deps.fetch(`${origin ?? deps.builtInOrigin}/api/device/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, ...info, model: info.model.slice(0, 200), pushToken: null }),
        });
      } catch {
        throw new Error("No internet. Check the connection and try again.");
      }
      if (res.status === 400 || res.status === 404 || res.status === 410)
        throw new Error("That code didn't work. It may have expired: ask for a new one.");
      if (!res.ok) throw new Error(`The server had a problem (${res.status}). Try again in a minute.`);
      await store.paired(PairResponse.parse(await res.json()));
    },

    /** Resume after a kill: tracking restarts now; the sync carries resume: true so the server audits it (SPEC §4). */
    async resume(): Promise<void> {
      await store.resume();
      // offline is fine: resumePending stays set and the background sync sends it later
      await deps.syncNow().catch(() => {});
    },
  };
}

export type ScreenDevice = ReturnType<typeof createScreenDevice>;
