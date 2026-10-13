/**
 * The driver app's composition root, minus native modules (those are passed in by ./native): one cycle runs
 * location wake → resolveMode → ping queue → syncOnce → apply config (service, intervals, kill latch) → OTA.
 * The location task's wakes are the clock (every activeIntervalS while active, idleHeartbeatS while idle), so this
 * works headless; a push or the screens call sync() to force a sync.
 */
import type { Mode, ModeResolution, SyncRequest } from "@eci-shuttle/shared/contracts";
import { resolveMode } from "@eci-shuttle/shared/schedule";
import { toPing } from "../location/plan";
import type { DeviceStore } from "../store/deviceStore";
import { type KV, parseJson, serial } from "../store/kv";
import type { PingQueue } from "../store/pingQueue";
import { syncOnce } from "../sync/client";
import { initialSyncState, nextSyncDelayMs, type SyncState, type Telemetry } from "../sync/sync";

/** expo-location fix, as toPing reads it. */
export type Fix = Parameters<typeof toPing>[0];

/** Same key the screens read (screens/deviceCore SYNC_KEY) for the server clock and "Last sync". */
const SYNC_KEY = "sync-state";

/** What the runtime keeps besides the device store: clock, last sync, backoff, what the server last heard. */
type Persisted = Pick<SyncState, "clockOffsetMs" | "lastSyncAt" | "failures"> & {
  /** phone clock of the last sync attempt, ok or not */
  lastAttemptAt: number | null;
  /** reportedMode of the last attempt; a different mode now means sync at once */
  reportedMode: Mode | null;
};

// Wakes drift a little early on Android; without slack a 15 min heartbeat that fires at 14:58 waits another 15 min.
const DUE_SLACK = 0.9;

export type RuntimeDeps = {
  store: DeviceStore;
  queue: PingQueue;
  files: KV;
  fetch: typeof fetch;
  builtInOrigin: string;
  now: () => number;
  random?: () => number;
  /** start / retune / stop the foreground service for this resolution (location/service syncLocationService) */
  location: { apply: (r: ModeResolution, idleHeartbeatS: number, serverNow: number) => Promise<unknown> };
  /** 0–100 or null; stamped on each ping and the sync */
  battery: () => Promise<number | null>;
  telemetry: () => Promise<Pick<Telemetry, "charging" | "permissions" | "appVersion">>;
  ota: {
    report: () => Promise<Pick<SyncRequest, "updateId" | "updateFailed">>;
    reconcile: (targetUpdateId: string | null) => Promise<unknown>;
  };
  /** undefined = leave the server's token as is */
  pushToken: () => Promise<string | undefined>;
};

export function createRuntime(deps: RuntimeDeps) {
  const one = serial();
  let lastMode: Mode = "unpaired";

  const loadPersisted = async (): Promise<Persisted> => {
    const v = (parseJson(await deps.files.get(SYNC_KEY)) ?? {}) as Partial<Persisted>;
    return {
      clockOffsetMs: v.clockOffsetMs ?? 0,
      lastSyncAt: v.lastSyncAt ?? null,
      failures: v.failures ?? 0,
      lastAttemptAt: v.lastAttemptAt ?? null,
      reportedMode: v.reportedMode ?? null,
    };
  };
  const savePersisted = (p: Persisted) => deps.files.set(SYNC_KEY, JSON.stringify(p));

  /** Resolve on server time and put the service in that state. A service that can't start must not stop the sync. */
  async function apply(p: Persisted) {
    const dc = await deps.store.deviceConfig();
    const serverNow = deps.now() + p.clockOffsetMs;
    const r = resolveMode(dc, serverNow);
    lastMode = r.mode;
    await deps.location.apply(r, dc?.idleHeartbeatS ?? 900, serverNow).catch((e) => {
      console.warn("location service", e instanceof Error ? e.message : e);
    });
    return { r, dc };
  }

  async function cycle(fixes: Fix[], force: boolean) {
    const now = deps.now();
    let p = await loadPersisted();
    const { r, dc } = await apply(p);

    // each fix by its own (server) time: a cached fix from before the window or a late batch after it
    const inWindow = fixes.filter((f) => resolveMode(dc, f.timestamp + p.clockOffsetMs).mode === "active");
    if (inWindow.length) {
      const battery = await deps.battery();
      await deps.queue.push(
        inWindow.flatMap((f) => toPing(f, battery) ?? []),
        now,
      );
    }

    const [st, token, origins] = await Promise.all([deps.store.state(), deps.store.token(), deps.store.origins()]);
    if (!token) return;
    const state: SyncState = {
      ...initialSyncState(deps.builtInOrigin),
      token,
      config: st.config,
      apiOrigin: origins[0] ?? deps.builtInOrigin,
      fallbackOrigin: origins[1] ?? null,
      clockOffsetMs: p.clockOffsetMs,
      resumePending: st.resumePending,
      lastSyncAt: p.lastSyncAt,
      failures: p.failures,
    };
    const delay = nextSyncDelayMs(r, now + p.clockOffsetMs, state, (deps.random ?? Math.random)());
    const due =
      force ||
      (delay !== null &&
        (p.lastAttemptAt === null || now - p.lastAttemptAt >= delay * DUE_SLACK || p.reportedMode !== r.mode));
    if (!due) return;

    const [battery, rest, ota, pushToken] = await Promise.all([
      deps.battery(),
      deps.telemetry(),
      deps.ota.report(),
      deps.pushToken(),
    ]);
    const telemetry: Telemetry = {
      ...rest,
      ...ota,
      battery,
      reportedMode: r.mode,
      ...(pushToken !== undefined && { pushToken }),
    };
    const pings = await deps.queue.batch(now);
    const out = await syncOnce(() => state, telemetry, pings, {
      fetch: deps.fetch,
      now: deps.now,
      builtInOrigin: deps.builtInOrigin,
    });
    p = { ...p, lastAttemptAt: now, reportedMode: r.mode, failures: out.state.failures };
    if (!out.ok) {
      await savePersisted(p);
      return;
    }
    // re-paired while the request was out: this response belongs to the old token (its pings were cleared with it)
    if ((await deps.store.token()) !== token) return;
    await deps.store.applySync(out.response, { sentResume: state.resumePending });
    await deps.queue.ack(pings.slice(0, out.sentPings));
    p = { ...p, clockOffsetMs: out.state.clockOffsetMs, lastSyncAt: out.state.lastSyncAt, failures: 0 };
    await savePersisted(p);
    await apply(p);
    // last: applying an update reloads the JS
    await deps.ota.reconcile(out.response.targetUpdateId);
  }

  const run = (fixes: Fix[], force: boolean) =>
    one(() =>
      cycle(fixes, force).catch((e) => {
        console.warn("runtime cycle", e instanceof Error ? e.message : e);
      }),
    );

  return {
    /** The location task's delivery: fixes while active, an empty clock tick while idle. Never throws. */
    wake: (fixes: Fix[]) => run(fixes, false),
    /** Sync now (push, Resume, pairing, app opened). Never throws. */
    sync: () => run([], true),
    /** Sync only if one is due (foreground timer when the location service isn't running). Never throws. */
    tick: () => run([], false),
    /** Mode from the last cycle, for OTA (never reload while active). */
    mode: () => lastMode,
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
