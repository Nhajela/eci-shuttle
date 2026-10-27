import type { ModeResolution, SyncResponse } from "@eci-shuttle/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDeviceStore } from "../store/deviceStore";
import { memoryKV } from "../store/kv";
import { createPingQueue } from "../store/pingQueue";
import { createRuntime, type RuntimeDeps } from "./runtime";

const T = Date.UTC(2026, 9, 14, 4, 0);
const ORIGIN = "https://eci-shuttle.example.com";
const MIN = 60_000;

const config = (over: Partial<SyncResponse> = {}): SyncResponse => ({
  configVersion: 3,
  killed: false,
  revoked: false,
  // active for the first hour, idle after
  schedule: [
    { startsAt: T - MIN, endsAt: T + 60 * MIN, mode: "active", intervalS: null, source: "service", label: "Run" },
  ],
  activeIntervalS: 10,
  idleHeartbeatS: 900,
  minAppVersion: null,
  apkUrl: null,
  targetUpdateId: null,
  apiOrigin: ORIGIN,
  serverTime: T,
  vehicleName: "Van 2",
  workspace: { slug: "test", isLive: false },
  ...over,
});

const fix = (t: number) => ({
  timestamp: t,
  coords: { latitude: 15.6, longitude: 73.7, accuracy: 5, speed: 3, heading: 90 },
});

async function setup(opts: { paired?: boolean; respond?: (body: Record<string, unknown>) => SyncResponse } = {}) {
  const files = memoryKV();
  const secure = memoryKV();
  const queue = createPingQueue(files);
  const store = createDeviceStore({ files, secure, builtInOrigin: ORIGIN, queue });
  if (opts.paired !== false) await store.paired({ deviceId: "d", token: "tok", config: config() });
  let now = T;
  const bodies: Record<string, unknown>[] = [];
  let respond = opts.respond ?? (() => config({ serverTime: now }));
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    bodies.push(body);
    return new Response(JSON.stringify(respond(body)), { status: 200 });
  });
  const applied: ModeResolution[] = [];
  const calls: { cfg: { activeIntervalS: number; idleHeartbeatS: number }; startedKey: string | null }[] = [];
  let nativeResult: { startedKey: string | null; needsApp: boolean } = { startedKey: "k1", needsApp: false };
  const ota = { report: vi.fn(async () => ({ updateId: "u1" })), reconcile: vi.fn(async () => "none") };
  const deps: RuntimeDeps = {
    store,
    queue,
    files,
    fetch: fetch as unknown as typeof globalThis.fetch,
    builtInOrigin: ORIGIN,
    now: () => now,
    random: () => 0,
    location: {
      apply: async (r, cfg, _now, startedKey) => {
        applied.push(r);
        calls.push({ cfg, startedKey });
        return nativeResult;
      },
    },
    battery: async () => 80,
    telemetry: async () => ({
      charging: false,
      permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
      appVersion: "0.1.0",
    }),
    ota,
    pushToken: async () => "ExponentPushToken[x]",
  };
  const rt = createRuntime(deps);
  return {
    rt,
    store,
    queue,
    files,
    fetch,
    bodies,
    applied,
    calls,
    setNative: (r: typeof nativeResult) => {
      nativeResult = r;
    },
    ota,
    deps,
    at: (t: number) => {
      now = t;
    },
    setRespond: (f: typeof respond) => {
      respond = f;
    },
    lastMode: () => applied.at(-1)?.mode,
  };
}

describe("runtime: location wake → resolveMode → queue → sync → apply", () => {
  it("unpaired: stops the service and never calls the server", async () => {
    const s = await setup({ paired: false });
    await s.rt.wake([fix(T)]);
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.lastMode()).toBe("unpaired");
    expect(await s.queue.size()).toBe(0);
  });

  it("active: queues the fixes, syncs them with full telemetry and acks the queue", async () => {
    const s = await setup();
    await s.rt.wake([fix(T - 1_000)]);
    expect(s.fetch).toHaveBeenCalledOnce();
    const body = s.bodies[0];
    expect(body.pings).toEqual([
      { recordedAt: T - 1_000, lat: 15.6, lng: 73.7, accuracy: 5, speed: 3, heading: 90, battery: 80 },
    ]);
    expect(body).toMatchObject({
      battery: 80,
      reportedMode: "active",
      appVersion: "0.1.0",
      updateId: "u1",
      pushToken: "ExponentPushToken[x]",
      appliedConfigVersion: 3,
    });
    expect(await s.queue.size()).toBe(0);
    expect(s.lastMode()).toBe("active");
    expect(s.ota.reconcile).toHaveBeenCalledWith(null);
    // the screens read the clock and last sync from here
    const saved = JSON.parse(s.files.dump()["sync-state"]);
    expect(saved).toMatchObject({ lastSyncAt: T, failures: 0, clockOffsetMs: 0 });
  });

  it("active: syncs about every 15s, not on every 10s fix", async () => {
    const s = await setup();
    await s.rt.wake([fix(T)]);
    s.at(T + 10_000);
    await s.rt.wake([fix(T + 10_000)]);
    expect(s.fetch).toHaveBeenCalledOnce();
    expect(await s.queue.size()).toBe(1);
    s.at(T + 20_000);
    await s.rt.wake([fix(T + 20_000)]);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.bodies[1].pings).toHaveLength(2);
    expect(await s.queue.size()).toBe(0);
  });

  it("judges each fix by its own time: before the window only the idle heartbeat cadence is kept", async () => {
    const s = await setup();
    // the always-on task delivers 10 s fixes from before startsAt too
    await s.rt.wake([fix(T - 5 * MIN), fix(T - 5 * MIN + 10_000), fix(T)]);
    expect(s.bodies[0].pings).toEqual([
      expect.objectContaining({ recordedAt: T - 5 * MIN }),
      expect.objectContaining({ recordedAt: T }),
    ]);
  });

  it("judges each fix by its own time: a batch delivered after endsAt keeps the in-window fixes", async () => {
    const s = await setup();
    s.at(T + 61 * MIN); // window ended at T+60
    await s.rt.wake([fix(T + 59 * MIN), fix(T + 61 * MIN)]);
    expect(s.bodies[0]).toMatchObject({ reportedMode: "idle" });
    expect(s.bodies[0].pings).toEqual([expect.objectContaining({ recordedAt: T + 59 * MIN })]);
  });

  it("idle: thins fixes to the heartbeat, syncs every idleHeartbeatS, and syncs at once when the mode flips", async () => {
    const s = await setup();
    s.at(T + 61 * MIN); // after the window
    await s.rt.wake([fix(T + 61 * MIN)]);
    expect(s.fetch).toHaveBeenCalledOnce();
    expect(s.bodies[0]).toMatchObject({
      reportedMode: "idle",
      pings: [expect.objectContaining({ recordedAt: T + 61 * MIN })],
    });
    s.at(T + 66 * MIN);
    await s.rt.wake([fix(T + 66 * MIN)]);
    expect(s.fetch).toHaveBeenCalledOnce();
    s.at(T + 76 * MIN); // 15 min after the last sync
    await s.rt.wake([]);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(await s.queue.size()).toBe(0);

    // a new window starts: the next wake reports active right away
    s.setRespond((b) =>
      config({
        serverTime: b.clock as number,
        schedule: [
          {
            startsAt: T + 77 * MIN,
            endsAt: T + 120 * MIN,
            mode: "active",
            intervalS: null,
            source: "service",
            label: "Run 2",
          },
        ],
        configVersion: (b.appliedConfigVersion as number) + 1,
      }),
    );
    s.at(T + 77 * MIN - 5_000);
    await s.rt.sync();
    expect(s.bodies.at(-1)).toMatchObject({ reportedMode: "idle" });
    s.at(T + 77 * MIN); // 5s later: not due by time, due because the mode changed
    await s.rt.wake([]);
    expect(s.fetch).toHaveBeenCalledTimes(4);
    expect(s.bodies.at(-1)).toMatchObject({ reportedMode: "active" });
  });

  it("uses the server clock from the last sync to resolve the mode", async () => {
    // the phone clock is an hour behind the server: the window is already over on server time
    const s = await setup({ respond: () => config({ serverTime: T + 2 * 60 * MIN }) });
    await s.rt.sync();
    expect(s.lastMode()).toBe("idle");
  });

  it("a failed sync keeps the pings and retries with backoff", async () => {
    const s = await setup();
    s.fetch.mockRejectedValueOnce(new Error("offline"));
    s.fetch.mockRejectedValueOnce(new Error("offline"));
    await s.rt.wake([fix(T)]);
    expect(await s.queue.size()).toBe(1);
    expect(JSON.parse(s.files.dump()["sync-state"]).failures).toBe(1);
    s.at(T + 2_000);
    await s.rt.wake([]);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    s.at(T + 3_000); // backoff for 1 failure with random 0 is 2.5s
    await s.rt.wake([]);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.ota.reconcile).not.toHaveBeenCalled();
  });

  it("a cycle that hangs is cut off: later cycles still run and no queued ping is lost", async () => {
    const s = await setup();
    s.deps.cycleTimeoutMs = 30;
    s.fetch.mockImplementationOnce(() => new Promise<Response>(() => {})); // never answers, ignores the abort
    await s.rt.wake([fix(T)]);
    expect(await s.queue.size()).toBe(1);
    expect(JSON.parse(s.files.dump()["sync-state"])).toMatchObject({ lastError: "timeout", failures: 1 });
    s.at(T + 10_000);
    await s.rt.wake([fix(T + 10_000)]);
    expect(s.bodies.at(-1)?.pings).toHaveLength(2);
    expect(await s.queue.size()).toBe(0);
    expect(JSON.parse(s.files.dump()["sync-state"])).toMatchObject({ lastError: null, failures: 0 });
  });

  it("a cycle cut off by the timeout does not apply its late response over the newer cycle", async () => {
    const s = await setup();
    s.deps.cycleTimeoutMs = 30;
    let release: (r: Response) => void = () => {};
    s.fetch.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    await s.rt.wake([fix(T)]);
    release(new Response(JSON.stringify(config({ configVersion: 99 })), { status: 200 }));
    await new Promise((r) => setTimeout(r, 10));
    expect((await s.store.state()).config?.configVersion).toBe(3);
  });

  it("records why a sync failed and clears it on success", async () => {
    const s = await setup();
    s.fetch.mockResolvedValueOnce(new Response("no", { status: 401 }));
    await s.rt.sync();
    expect(JSON.parse(s.files.dump()["sync-state"]).lastError).toBe("unauthorized");
    await s.rt.sync();
    expect(JSON.parse(s.files.dump()["sync-state"]).lastError).toBeNull();
  });

  it("429: waits out Retry-After before the next scheduled sync, and tries one origin only", async () => {
    const s = await setup();
    s.fetch.mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "60" } }));
    await s.rt.wake([fix(T)]);
    expect(s.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(s.files.dump()["sync-state"]).lastError).toBe("http_429");
    s.at(T + 30_000); // backoff alone (2.5s) would be over; the server asked for 60s
    await s.rt.wake([fix(T + 30_000)]);
    expect(s.fetch).toHaveBeenCalledOnce();
    s.at(T + 61_000);
    await s.rt.wake([fix(T + 61_000)]);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(await s.queue.size()).toBe(0);
  });

  it("a kill is latched: the service stops and wakes no longer sync", async () => {
    const s = await setup({ respond: () => config({ killed: true }) });
    await s.rt.wake([fix(T)]);
    expect(s.lastMode()).toBe("killed");
    expect((await s.store.state()).killLatched).toBe(true);
    s.setRespond(() => config());
    s.at(T + 60_000);
    await s.rt.wake([fix(T + 60_000)]);
    expect(s.fetch).toHaveBeenCalledOnce();
    expect(s.lastMode()).toBe("killed");
    expect(await s.queue.size()).toBe(0);
  });

  it("sync() after Resume sends resume: true and restarts tracking", async () => {
    const s = await setup({ respond: () => config({ killed: true }) });
    await s.rt.sync();
    expect(s.lastMode()).toBe("killed");
    s.setRespond(() => config());
    await s.store.resume();
    s.at(T + 1_000);
    await s.rt.sync();
    expect(s.bodies.at(-1)?.resume).toBe(true);
    expect(s.lastMode()).toBe("active");
    expect((await s.store.state()).resumePending).toBe(false);
  });

  it("a revoke wipes the token and the queue and stops the service", async () => {
    const s = await setup({ respond: () => config({ revoked: true }) });
    await s.queue.push(
      [{ recordedAt: T - 5_000, lat: 1, lng: 1, accuracy: 5, speed: null, heading: null, battery: null }],
      T,
    );
    s.fetch.mockImplementationOnce(async () => {
      await s.queue.push(
        [{ recordedAt: T - 4_000, lat: 1, lng: 1, accuracy: 5, speed: null, heading: null, battery: null }],
        T,
      );
      return new Response(JSON.stringify(config({ revoked: true })), { status: 200 });
    });
    await s.rt.sync();
    expect(await s.store.token()).toBeNull();
    expect(await s.queue.size()).toBe(0);
    expect(s.lastMode()).toBe("revoked");
    s.at(T + 60_000);
    await s.rt.sync();
    expect(s.fetch).toHaveBeenCalledOnce();
  });

  it("drops a response that belongs to a pairing replaced mid-flight", async () => {
    const s = await setup();
    s.fetch.mockImplementationOnce(async () => {
      await s.store.paired({
        deviceId: "d2",
        token: "tok2",
        config: config({ configVersion: 9, vehicleName: "Van 9" }),
      });
      return new Response(JSON.stringify(config({ configVersion: 4 })), { status: 200 });
    });
    await s.rt.sync();
    expect((await s.store.state()).config?.vehicleName).toBe("Van 9");
    expect(await s.store.token()).toBe("tok2");
  });

  it("hands the location service the config intervals and the key it last started with", async () => {
    const s = await setup();
    await s.rt.sync();
    expect(s.calls[0]).toEqual({ cfg: { activeIntervalS: 10, idleHeartbeatS: 900 }, startedKey: null });
    await s.rt.sync();
    expect(s.calls.at(-1)?.startedKey).toBe("k1"); // persisted from the first apply
  });

  it("persists 'open the app to start tracking' from the location service and clears it", async () => {
    const s = await setup();
    s.setNative({ startedKey: null, needsApp: true });
    await s.rt.wake([]);
    expect(JSON.parse(s.files.dump()["sync-state"])).toMatchObject({ needsApp: true });
    s.setNative({ startedKey: "k1", needsApp: false });
    await s.rt.wake([]);
    expect(JSON.parse(s.files.dump()["sync-state"])).toMatchObject({ needsApp: false });
  });

  it("the idle cadence survives between wakes (new process each time)", async () => {
    const s = await setup();
    s.at(T + 61 * MIN);
    await s.rt.wake([fix(T + 61 * MIN)]);
    s.at(T + 62 * MIN);
    await s.rt.wake([fix(T + 62 * MIN)]);
    expect(await s.queue.size()).toBe(0); // first was synced and acked; the second was thinned away, not queued
    expect(JSON.parse(s.files.dump()["sync-state"]).lastKeptAt).toBe(T + 61 * MIN);
  });

  it("a location service that can't start (no permission yet) does not stop the sync", async () => {
    const s = await setup();
    s.deps.location.apply = async () => {
      throw new Error("permission");
    };
    await s.rt.wake([fix(T)]);
    expect(s.fetch).toHaveBeenCalledOnce();
  });

  it("passes the server's targetUpdateId to OTA after the sync", async () => {
    const s = await setup({ respond: () => config({ targetUpdateId: "u2" }) });
    await s.rt.sync();
    expect(s.ota.reconcile).toHaveBeenCalledWith("u2");
    expect(s.rt.mode()).toBe("active");
  });

  it("runs one cycle at a time (location task, push and screens may fire together)", async () => {
    const s = await setup();
    let inFlight = 0;
    let most = 0;
    s.fetch.mockImplementation(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify(config()), { status: 200 });
    });
    await Promise.all([s.rt.wake([fix(T)]), s.rt.sync(), s.rt.sync()]);
    expect(s.fetch).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
    expect(await s.queue.size()).toBe(0);
  });
});
