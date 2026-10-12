import { type DeviceConfig, type PairResponse, SyncResponse } from "@eci-shuttle/shared/contracts";
import { type KV, parseJson, serial } from "./kv";

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

/**
 * A stored config that no longer fits SyncResponse (e.g. an OTA added a field) keeps every field that still parses
 * and takes safe values for the rest, so the phone stays paired and its next sync brings a full config.
 */
function readConfig(v: unknown, builtInOrigin: string): SyncResponse | null {
  const strict = SyncResponse.safeParse(v);
  if (strict.success) return strict.data;
  if (!v || typeof v !== "object") return null;
  const out: Record<string, unknown> = {
    configVersion: 1,
    killed: false,
    revoked: false,
    schedule: [],
    activeIntervalS: 10,
    idleHeartbeatS: 900,
    minAppVersion: null,
    apkUrl: null,
    targetUpdateId: null,
    apiOrigin: builtInOrigin,
    serverTime: 0,
    vehicleName: null,
    workspace: { slug: "", isLive: false },
  };
  for (const [k, field] of Object.entries(SyncResponse.shape)) {
    const r = field.safeParse((v as Record<string, unknown>)[k]);
    if (r.success) out[k] = r.data;
  }
  const loose = SyncResponse.safeParse(out);
  return loose.success ? loose.data : null;
}

function readState(raw: string | null, builtInOrigin: string): DeviceState {
  const v = parseJson(raw) as Partial<DeviceState> | null;
  if (!v || typeof v !== "object") return EMPTY;
  // latch fields are read on their own: a bad config must never drop a latched kill (SPEC §4)
  return {
    config: readConfig(v.config, builtInOrigin),
    killLatched: v.killLatched === true,
    resumePending: v.resumePending === true,
    prevApiOrigin: typeof v.prevApiOrigin === "string" ? v.prevApiOrigin : null,
  };
}

export function createDeviceStore({
  files,
  secure,
  builtInOrigin,
  queue,
}: {
  files: KV;
  secure: KV;
  builtInOrigin: string;
  /** queued pings, cleared whenever the token is wiped or replaced so they never upload under another device/vehicle */
  queue: { clear(): Promise<void> };
}) {
  const one = serial();
  const load = async () => readState(await files.get(STATE_KEY), builtInOrigin);
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
      await queue.clear();
      await secure.set(TOKEN_KEY, token);
      await update(() => ({ ...EMPTY, config, killLatched: config.killed }));
    },

    /** Store a sync response. `sentResume`: the request carried `resume: true`. */
    applySync(resp: SyncResponse, { sentResume }: { sentResume: boolean }) {
      return update(async (s) => {
        if (resp.revoked) await Promise.all([secure.del(TOKEN_KEY), queue.clear()]);
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
