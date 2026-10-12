import { type ModeResolution, type PairResponse, SyncRequest, type SyncResponse } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import { pairSim, runSim as realRunSim } from "./device";
import { buildPlan } from "./plan";

const T0 = Date.UTC(2026, 9, 20, 4, 0, 0);
const plan = buildPlan(
  {
    path: [
      { lat: 15.65, lng: 73.7 },
      { lat: 15.67, lng: 73.7 },
    ],
    spotPathIdx: [0, 1],
    typicalLegS: [600],
  },
  { dwellS: 60, kmh: 25 },
);

const config = (over: Partial<SyncResponse> = {}): SyncResponse => ({
  configVersion: 3,
  killed: false,
  revoked: false,
  schedule: [],
  activeIntervalS: 10,
  idleHeartbeatS: 900,
  minAppVersion: null,
  apkUrl: null,
  targetUpdateId: null,
  apiOrigin: "http://localhost:3000",
  serverTime: T0,
  vehicleName: "Bus 1",
  workspace: { slug: "test", isLive: false },
  ...over,
});

const mode = (m: "active" | "idle", intervalS: number) => (): ModeResolution => ({
  mode: m,
  intervalS,
  until: null,
  window: null,
  next: null,
});
/** most tests are about syncing, so the schedule says "active every activeIntervalS (10 s)" */
const runSim = (o: Parameters<typeof realRunSim>[0]) => realRunSim({ mode: mode("active", 10), ...o });

type Call = { url: string; init: RequestInit };

/** A fake server and clock: sleep advances the clock; each sync is answered by `answer(n)`. */
function harness(answer: (n: number) => Response | Error) {
  let now = T0;
  const calls: Call[] = [];
  const ctrl = new AbortController();
  const deps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = answer(calls.length);
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    log: () => {},
  };
  const bodies = () => calls.map((c) => SyncRequest.parse(JSON.parse(String(c.init.body))));
  return { deps, calls, ctrl, bodies };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("pairSim", () => {
  it("swaps the code for a token through POST /api/device/pair", async () => {
    const res: PairResponse = { deviceId: crypto.randomUUID(), token: "tok", config: config() };
    const h = harness(() => json(res));
    expect(await pairSim("http://x", "123456", h.deps)).toEqual(res);
    expect(h.calls[0].url).toBe("http://x/api/device/pair");
    expect(JSON.parse(String(h.calls[0].init.body))).toMatchObject({ code: "123456", model: "sim" });
  });

  it("throws the server's message when pairing fails", async () => {
    const h = harness(() => json({ error: "That code has expired." }, 410));
    await expect(pairSim("http://x", "1", h.deps)).rejects.toThrow(/expired/);
  });
});

describe("runSim", () => {
  it("syncs valid requests with a bearer token, batching pings, until stopped", async () => {
    const h = harness((n) => {
      if (n === 3) h.ctrl.abort();
      return json(config({ configVersion: 4, serverTime: h.deps.now() }));
    });
    const out = await runSim({
      origin: "http://x",
      token: "tok",
      config: config(),
      plan,
      speed: 1,
      deps: h.deps,
      signal: h.ctrl.signal,
    });
    expect(out).toBe("stopped");
    expect(h.calls.every((c) => c.url === "http://x/api/device/sync")).toBe(true);
    expect((h.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const [first, second] = h.bodies();
    expect(first.appliedConfigVersion).toBe(3);
    expect(second.appliedConfigVersion).toBe(4);
    expect(first.reportedMode).toBe("active");
    // first sync right away with one fix; then every ~15 s (two 10 s fixes)
    expect(first.pings).toHaveLength(1);
    expect(second.pings).toHaveLength(2);
    expect(second.pings[0].recordedAt).toBe(T0 + 10_000);
  });

  it("at Nx the vehicle moves N times further per real second, timestamps stay real", async () => {
    const run = async (speed: number) => {
      const h = harness((n) => {
        if (n === 2) h.ctrl.abort();
        return json(config());
      });
      await runSim({
        origin: "http://x",
        token: "t",
        config: config(),
        plan,
        speed,
        deps: h.deps,
        signal: h.ctrl.signal,
      });
      return h.bodies()[1].pings.at(-1);
    };
    const slow = await run(1);
    const fast = await run(10);
    expect(fast?.recordedAt).toBe(slow?.recordedAt);
    // 20 s real: 1x is still dwelling at the first spot, 10x (200 s sim) is driving
    expect(slow?.lat).toBe(15.65);
    expect(fast?.lat).toBeGreaterThan(15.65);
  });

  it("keeps pings queued across a failed sync and resends them", async () => {
    const h = harness((n) => {
      if (n === 1) return new Error("ECONNREFUSED");
      if (n === 2) return json({ error: "boom" }, 500);
      if (n === 3) h.ctrl.abort();
      return json(config());
    });
    await runSim({
      origin: "http://x",
      token: "t",
      config: config(),
      plan,
      speed: 1,
      deps: h.deps,
      signal: h.ctrl.signal,
    });
    const third = h.bodies()[2];
    expect(third.pings.length).toBeGreaterThanOrEqual(3);
    expect(third.pings[0].recordedAt).toBe(T0);
  });

  it("stops when the server kills, revokes, or the workspace is live", async () => {
    for (const [over, want] of [
      [{ killed: true }, "killed"],
      [{ revoked: true }, "revoked"],
      [{ workspace: { slug: "live", isLive: true } }, "live"],
    ] as const) {
      const h = harness(() => json(config(over)));
      expect(await runSim({ origin: "http://x", token: "t", config: config(), plan, speed: 1, deps: h.deps })).toBe(
        want,
      );
    }
    const h = harness(() => json({ error: "Unknown device." }, 401));
    expect(await runSim({ origin: "http://x", token: "t", config: config(), plan, speed: 1, deps: h.deps })).toBe(
      "revoked",
    );
  });

  it("follows the schedule: idle sends heartbeat syncs with no pings, every idleHeartbeatS", async () => {
    const h = harness((n) => {
      if (n === 3) h.ctrl.abort();
      return json(config());
    });
    await realRunSim({
      origin: "http://x",
      token: "t",
      config: config(),
      plan,
      speed: 1,
      deps: h.deps,
      signal: h.ctrl.signal,
      mode: mode("idle", 900),
    });
    const bodies = h.bodies();
    expect(bodies).toHaveLength(3);
    expect(bodies.every((b) => b.reportedMode === "idle" && b.pings.length === 0)).toBe(true);
    expect(bodies[1].clock - bodies[0].clock).toBe(900_000);
  });

  it("uses the active window's interval, and switches mode when the schedule does", async () => {
    let n = 0;
    const h = harness((c) => {
      if (c === 3) h.ctrl.abort();
      return json(config());
    });
    await realRunSim({
      origin: "http://x",
      token: "t",
      config: config(),
      plan,
      speed: 1,
      deps: h.deps,
      signal: h.ctrl.signal,
      // first loop idle (heartbeat), then an active window pinging every 5 s
      mode: () => (n++ === 0 ? mode("idle", 30)() : mode("active", 5)()),
    });
    const [first, second, third] = h.bodies();
    expect(first).toMatchObject({ reportedMode: "idle", pings: [] });
    // idle 30 s, then active fixes every 5 s, synced once 15 s have passed since the last sync
    expect(second.reportedMode).toBe("active");
    expect(second.pings.map((p) => p.recordedAt - T0)).toEqual([30_000]);
    expect(third.pings.map((p) => p.recordedAt - T0)).toEqual([35_000, 40_000, 45_000]);
  });
});
