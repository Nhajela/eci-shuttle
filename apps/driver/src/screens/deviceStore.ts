// ponytail: verbatim copy of task/driver-store src/store/deviceStore.ts (same createDeviceStore signatures).
// On merge, delete this file and import from "../store/deviceStore".
import { type DeviceConfig, type PairResponse, SyncResponse } from "@eci-shuttle/shared/contracts";
import { type KV, parseJson, serial } from "./storeKv";

const STATE_KEY = "device-state";
const TOKEN_KEY = "device-token";

/** Everything on disk except the token (which lives in SecureStore). */
export type DeviceState = {
  /** last config the server sent; null = never paired */
  config: SyncResponse | null;
  /** SPEC §4: a server kill is latched here; only resume() clears it */
  killLatched: boolean;
  /** Resume pressed; send `resume: true` on the next sync until it is answered */
  resumePending: boolean;
  /** previous apiOrigin, tried after config.apiOrigin and before the built-in domain (SPEC §2a) */
  prevApiOrigin: string | null;
};

const EMPTY: DeviceState = { config: null, killLatched: false, resumePending: false, prevApiOrigin: null };

const trimSlash = (s: string) => s.replace(/\/+$/, "");

function readState(raw: string | null): DeviceState {
  const v = parseJson(raw) as Partial<DeviceState> | null;
  if (!v || typeof v !== "object") return EMPTY;
  const config = SyncResponse.safeParse(v.config);
  if (!config.success) return EMPTY;
  return {
    config: config.data,
    killLatched: v.killLatched === true,
    resumePending: v.resumePending === true,
    prevApiOrigin: typeof v.prevApiOrigin === "string" ? v.prevApiOrigin : null,
  };
}

export function createDeviceStore({ files, secure, builtInOrigin }: { files: KV; secure: KV; builtInOrigin: string }) {
  const one = serial();
  const load = async () => readState(await files.get(STATE_KEY));
  const update = (fn: (s: DeviceState) => DeviceState | Promise<DeviceState>) =>
    one(async () => {
      const next = await fn(await load());
      await files.set(STATE_KEY, JSON.stringify(next));
      return next;
    });

  return {
    state: () => one(load),
    token: () => secure.get(TOKEN_KEY),

    /** Config for resolveMode(config, now): null = unpaired; `killed` is the latched kill, not the last response. */
    async deviceConfig(): Promise<DeviceConfig | null> {
      const [s, token] = await Promise.all([one(load), secure.get(TOKEN_KEY)]);
      if (!s.config || (!token && !s.config.revoked)) return null;
      const { configVersion, revoked, schedule, activeIntervalS, idleHeartbeatS } = s.config;
      return { configVersion, killed: s.killLatched, revoked, schedule, activeIntervalS, idleHeartbeatS };
    },

    /** Origins to try for the next request, in order. */
    async origins(): Promise<string[]> {
      const s = await one(load);
      const all = [s.config?.apiOrigin, s.prevApiOrigin, builtInOrigin].filter((o): o is string => !!o).map(trimSlash);
      return [...new Set(all)];
    },

    async paired({ token, config }: PairResponse) {
      await secure.set(TOKEN_KEY, token);
      await update(() => ({ ...EMPTY, config, killLatched: config.killed }));
    },

    /** Store a sync response. `sentResume`: the request carried `resume: true`. */
    applySync(resp: SyncResponse, { sentResume }: { sentResume: boolean }) {
      return update(async (s) => {
        if (resp.revoked) await secure.del(TOKEN_KEY);
        const oldOrigin = s.config?.apiOrigin;
        return {
          config: resp,
          // a response to a pre-Resume request must not re-latch a kill the driver just cleared
          killLatched: sentResume ? resp.killed : s.resumePending ? false : s.killLatched || resp.killed,
          resumePending: sentResume ? false : s.resumePending,
          prevApiOrigin: oldOrigin && oldOrigin !== resp.apiOrigin ? oldOrigin : s.prevApiOrigin,
        };
      });
    },

    /** The driver pressed Resume: track again right away, tell the server on the next sync. */
    resume() {
      return update((s) => ({ ...s, killLatched: false, resumePending: true }));
    },
  };
}

export type DeviceStore = ReturnType<typeof createDeviceStore>;
