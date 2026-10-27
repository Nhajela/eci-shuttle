/**
 * The driver app's composition root, minus native modules (those are passed in by ./native): one cycle runs
 * location wake → resolveMode → ping queue → syncOnce → apply config (service, intervals, kill latch) → OTA.
 * The location task's wakes (a fix per active or idle interval) are the clock, so this works headless;
 * a push or the screens call sync() to force a sync.
 */
import type { Mode, ModeResolution, SyncRequest } from "@eci-shuttle/shared/contracts";
import { resolveMode } from "@eci-shuttle/shared/schedule";
import type { NativeState } from "../location/apply";
import { type Fix, gateFixes, toPing } from "../location/plan";
import type { DeviceStore } from "../store/deviceStore";
import { type KV, parseJson, serial } from "../store/kv";
import type { PingQueue } from "../store/pingQueue";
import { syncOnce } from "../sync/client";
import { initialSyncState, nextSyncDelayMs, type SyncState, type Telemetry } from "../sync/sync";

/** Same key the screens read (screens/deviceCore SYNC_KEY) for the server clock and "Last sync". */
const SYNC_KEY = "sync-state";

/** What the runtime keeps besides the device store: clock, last sync, backoff, what the server last heard. */
type Persisted = Pick<SyncState, "clockOffsetMs" | "lastSyncAt" | "failures"> & {
  /** phone clock of the last sync attempt, ok or not */
  lastAttemptAt: number | null;
  /** reportedMode of the last attempt; a different mode now means sync at once */
  reportedMode: Mode | null;
  /** why the last attempt failed (SyncError), null after a success; the status screen shows it */
  lastError: string | null;
  /** phone clock before which a 429 asked us not to sync again (Retry-After) */
  retryAfterAt: number | null;
  /** location/apply NativeState, flattened: key of the last native start, "open the app" flag, patch fallback, reminder */
  nativeKey: string | null;
  needsApp: boolean;
  degradedAt: string | null;
  reminderFor: number | null;
  /** time of the last fix kept by gateFixes, so the idle/active cadence holds across wakes */
  lastKeptAt: number | null;
};

/**
 * One cycle gets this long (3 origins × 20 s request deadline, plus disk and OTA). Past it the serial queue moves on,
 * so a stuck native call or socket can't stop every later wake, push and sync.
 */
export const CYCLE_TIMEOUT_MS = 90_000;

// Wakes drift a little early on Android; without slack a 15 min heartbeat that fires at 14:58 waits another 15 min.
const DUE_SLACK = 0.9;

export type RuntimeDeps = {
  store: DeviceStore;
  queue: PingQueue;
  files: KV;
  fetch: typeof fetch;
  builtInOrigin: string;
  now: () => number;
  /** per-cycle deadline, default CYCLE_TIMEOUT_MS */
  cycleTimeoutMs?: number;
  /** how long a ping waits for the battery reading before it is stamped null, default 2 s */
  batteryTimeoutMs?: number;
  /** true / false / null (unknown); lets an unpatched phone on a charger skip the overnight stop */
  charging: () => Promise<boolean | null>;
  random?: () => number;
  /**
   * Put the native task (and the start reminder) in the state the plan wants, as far as this build and the app's
   * foreground state allow (location/service syncLocationService). `prev` is what we persisted from the last call.
   */
  location: {
    apply: (
      r: ModeResolution,
      cfg: { activeIntervalS: number; idleHeartbeatS: number; charging: boolean | null; clockOffsetMs: number },
      serverNow: number,
      prev: NativeState,
    ) => Promise<(NativeState & { registered?: boolean }) | undefined>;
    /** the cycle saved the result of a foreground registration: the task is now verified for this process */
    confirm?: () => void;
  };
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
      lastError: v.lastError ?? null,
      retryAfterAt: v.retryAfterAt ?? null,
      nativeKey: v.nativeKey ?? null,
      needsApp: v.needsApp ?? false,
      degradedAt: v.degradedAt ?? null,
      reminderFor: v.reminderFor ?? null,
      lastKeptAt: v.lastKeptAt ?? null,
    };
  };
  const savePersisted = (p: Persisted) => deps.files.set(SYNC_KEY, JSON.stringify(p));

  /**
   * Merge `change` into what is on disk NOW and save (never a stale copy: a cut-off cycle and a newer one may overlap).
   * A cycle that has been cut off writes nothing: returns null.
   */
  async function patch(change: Partial<Persisted>, cancelled: () => boolean): Promise<Persisted | null> {
    const cur = await loadPersisted();
    if (cancelled()) return null;
    const next = { ...cur, ...change };
    await savePersisted(next);
    return next;
  }

  /**
   * Resolve on server time and put the service in that state. A service that can't start must not stop the sync.
   * Records what the native side reported (key it started with, "open the app" flag, patch fallback, reminder).
   * A cut-off cycle makes no native call and saves nothing.
   */
  async function apply(p: Persisted, cancelled: () => boolean): Promise<{ r: ModeResolution; p: Persisted }> {
    const dc = await deps.store.deviceConfig();
    const serverNow = deps.now() + p.clockOffsetMs;
    const r = resolveMode(dc, serverNow);
    lastMode = r.mode;
    try {
      const charging = await deps.charging().catch(() => null);
      if (cancelled()) return { r, p };
      const cfg = {
        activeIntervalS: dc?.activeIntervalS ?? 10,
        idleHeartbeatS: dc?.idleHeartbeatS ?? 900,
        charging,
        clockOffsetMs: p.clockOffsetMs,
      };
      const prev: NativeState = {
        startedKey: p.nativeKey,
        needsApp: p.needsApp,
        degradedAt: p.degradedAt,
        reminderFor: p.reminderFor,
      };
      const res = await deps.location.apply(r, cfg, serverNow, prev);
      if (res) {
        const { registered, ...next } = res;
        let saved = true;
        if (JSON.stringify(next) !== JSON.stringify(prev)) {
          const written = await patch(
            {
              nativeKey: next.startedKey,
              needsApp: next.needsApp,
              degradedAt: next.degradedAt,
              reminderFor: next.reminderFor,
            },
            cancelled,
          );
          saved = written !== null;
          if (written) p = written;
        }
        // only a cycle that is still current and has the key on disk may call the task verified
        if (registered && saved && !cancelled()) deps.location.confirm?.();
      }
    } catch (e) {
      console.warn("location service", e instanceof Error ? e.message : e);
    }
    return { r, p };
  }

  /** `v`, or `fallback` if it rejects or takes longer than `ms`. */
  async function bounded<T>(v: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    });
    try {
      return await Promise.race([v.catch(() => fallback), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function cycle(fixes: Fix[], force: boolean, cancelled: () => boolean, progress: { synced: boolean }) {
    const now = deps.now();
    let p = await loadPersisted();
    const dc = await deps.store.deviceConfig();

    // Queue the fixes before anything that can hang (native calls, network): a cut-off cycle must not lose them.
    // gateFixes keeps fixes at the active cadence inside windows and drops the rest (idle polling, killed, revoked);
    // idle check-ins still sync, just without pings. Each fix is judged by its own (server) time.
    // The battery stamp is bounded so a stuck reading can't hold the fixes back.
    const gated = gateFixes(fixes, dc, p.clockOffsetMs, p.lastKeptAt);
    if (gated.keep.length) {
      const battery = await bounded(deps.battery(), deps.batteryTimeoutMs ?? 2_000, null);
      await deps.queue.push(
        gated.keep.flatMap((f) => toPing(f, battery) ?? []),
        now,
      );
      const saved = await patch({ lastKeptAt: gated.lastKeptAt }, cancelled);
      if (saved) p = saved;
    }
    if (cancelled()) return;
    const applied = await apply(p, cancelled);
    const r = applied.r;
    p = applied.p;
    if (cancelled()) return;

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
    // a 429's Retry-After holds back every sync, forced ones included
    const rateLimited = p.retryAfterAt !== null && now < p.retryAfterAt;
    const due =
      !rateLimited &&
      (force ||
        (delay !== null &&
          (p.lastAttemptAt === null || now - p.lastAttemptAt >= delay * DUE_SLACK || p.reportedMode !== r.mode)));
    if (!due) return;

    const [battery, rest, ota, pushToken] = await Promise.all([
      bounded(deps.battery(), deps.batteryTimeoutMs ?? 2_000, null),
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
    // cut off while the request was out: a newer cycle owns the state now, and unacked pings are simply resent
    if (cancelled()) return;
    const attempt = { lastAttemptAt: now, reportedMode: r.mode, failures: out.state.failures };
    if (!out.ok) {
      await patch(
        {
          ...attempt,
          lastError: out.error,
          retryAfterAt: out.retryAfterMs === undefined ? null : now + out.retryAfterMs,
        },
        cancelled,
      );
      return;
    }
    // the server has the pings and answered: whatever is slow from here (disk, OTA) is not a failed sync
    progress.synced = true;
    // re-paired while the request was out: this response belongs to the old token (its pings were cleared with it)
    if ((await deps.store.token()) !== token || cancelled()) return;
    await deps.store.applySync(out.response, { sentResume: state.resumePending });
    if (cancelled()) return;
    await deps.queue.ack(pings.slice(0, out.sentPings));
    const saved = await patch(
      {
        ...attempt,
        failures: 0,
        clockOffsetMs: out.state.clockOffsetMs,
        lastSyncAt: out.state.lastSyncAt,
        lastError: null,
        retryAfterAt: null,
      },
      cancelled,
    );
    if (!saved) return;
    await apply(saved, cancelled);
    // last: applying an update reloads the JS
    if (cancelled()) return;
    await deps.ota.reconcile(out.response.targetUpdateId);
  }

  /** One cycle with a deadline. On timeout the queue moves on and the late cycle is told to stand down. */
  const run = (fixes: Fix[], force: boolean) =>
    one(async () => {
      let cut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), deps.cycleTimeoutMs ?? CYCLE_TIMEOUT_MS);
      });
      const progress = { synced: false };
      const work = cycle(fixes, force, () => cut, progress).catch((e) => {
        console.warn("runtime cycle", e instanceof Error ? e.message : e);
      });
      const done = await Promise.race([work, timeout]);
      clearTimeout(timer);
      if (done !== "timeout") return;
      cut = true;
      console.warn("runtime cycle timed out");
      // only a sync that never got an answer is a failed sync; a slow OTA step after a good one is not
      if (progress.synced) return;
      const p = await loadPersisted();
      await savePersisted({ ...p, lastError: "timeout", failures: p.failures + 1 }).catch(() => {});
    });

  return {
    /** The location task's delivery: fixes while active, an empty clock tick while idle. Never throws. */
    wake: (fixes: Fix[]) => run(fixes, false),
    /** Sync now (push, Resume, pairing, app opened). Never throws. */
    sync: () => run([], true),
    /** Sync only if one is due (foreground timer when the location service isn't running). Never throws. */
    tick: () => run([], false),
    /** true while the plan wants tracking and only opening the app can start it (read by native.ts to retry) */
    needsApp: async () => (await loadPersisted()).needsApp,
    /** Mode from the last cycle, for OTA (never reload while active). */
    mode: () => lastMode,
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
