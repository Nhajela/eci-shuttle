import { SyncRequest, type SyncResponse } from "@eci-shuttle/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import { syncOnce } from "./client";
import { initialSyncState, requestResume, type SyncState, type Telemetry } from "./sync";

const T = 1_760_000_000_000;
const ORIGIN = "https://eci-shuttle.positivesumcompany.com";
const OLD = "https://old.example.com";

const body = (over: Partial<SyncResponse> = {}): SyncResponse => ({
  configVersion: 5,
  killed: false,
  revoked: false,
  schedule: [],
  activeIntervalS: 10,
  idleHeartbeatS: 900,
  minAppVersion: null,
  apkUrl: null,
  targetUpdateId: null,
  apiOrigin: ORIGIN,
  serverTime: T,
  vehicleName: null,
  workspace: { slug: "test", isLive: false },
  ...over,
});

const state = (over: Partial<SyncState> = {}): SyncState => ({ ...initialSyncState(ORIGIN), token: "tok", ...over });

const telemetry: Telemetry = {
  battery: 50,
  charging: true,
  permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
  reportedMode: "idle",
  appVersion: "1.0.0",
  updateId: null,
};

const ping = { recordedAt: T - 1_000, lat: 15.6, lng: 73.7, accuracy: 5, speed: null, heading: null, battery: 50 };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const deps = (fetch: typeof globalThis.fetch) => ({ fetch, now: () => T, timeoutMs: 50 });

describe("syncOnce", () => {
  it("POSTs the request with the bearer token and applies the response", async () => {
    const fetch = vi.fn(async () => json(body()));
    const out = await syncOnce(() => state(), telemetry, [ping], deps(fetch));

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/device/sync`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const sent = JSON.parse(init.body as string);
    expect(sent.pings).toHaveLength(1);
    expect(sent.clock).toBe(T);

    expect(out.ok).toBe(true);
    expect(out.sentPings).toBe(1);
    expect(out.state.config?.configVersion).toBe(5);
    expect(out.state.lastSyncAt).toBe(T);
  });

  it("does nothing without a token", async () => {
    const fetch = vi.fn();
    const out = await syncOnce(() => state({ token: null }), telemetry, [ping], deps(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, error: "unpaired", sentPings: 0 });
  });

  it("falls back to the previous origin when the current one is unreachable", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(ORIGIN)) throw new TypeError("Network request failed");
      return json(body({ apiOrigin: OLD }));
    });
    const out = await syncOnce(() => state({ fallbackOrigin: OLD }), telemetry, [], deps(fetch as never));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(out.ok).toBe(true);
    expect(out.state.apiOrigin).toBe(OLD);
  });

  it("counts a failure and keeps the state when offline", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    const s = state({ failures: 2 });
    const out = await syncOnce(() => s, telemetry, [ping], deps(fetch));
    expect(out).toMatchObject({ ok: false, error: "network", sentPings: 0 });
    expect(out.state).toEqual({ ...s, failures: 3 });
  });

  it("times out a hung request", async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const out = await syncOnce(() => state(), telemetry, [], deps(fetch as never));
    expect(out).toMatchObject({ ok: false, error: "network" });
  });

  it("falls through to the fallback when the current origin answers wrong (404, HTML)", async () => {
    for (const bad of [json({}, 404), new Response("<html>parked</html>", { status: 200 })]) {
      const fetch = vi.fn(async (url: string) =>
        url.startsWith(ORIGIN) ? bad.clone() : json(body({ apiOrigin: OLD })),
      );
      const out = await syncOnce(() => state({ fallbackOrigin: OLD }), telemetry, [], deps(fetch as never));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(out.ok).toBe(true);
      expect(out.state.apiOrigin).toBe(OLD);
    }
  });

  it("tries the built-in origin last, and reports the first origin's error when all fail", async () => {
    const BUILT_IN = "https://built-in.example.com";
    const fetch = vi.fn(async (url: string) => (url.startsWith(BUILT_IN) ? json(body()) : json({}, 404)));
    const out = await syncOnce(
      () => state({ apiOrigin: "https://a.example.com", fallbackOrigin: OLD }),
      telemetry,
      [],
      {
        ...deps(fetch as never),
        builtInOrigin: BUILT_IN,
      },
    );
    expect(fetch.mock.calls.map((c) => new URL(c[0]).origin)).toEqual(["https://a.example.com", OLD, BUILT_IN]);
    expect(out.ok).toBe(true);

    const allBad = vi.fn(async (url: string) => (url.startsWith(OLD) ? json({}, 500) : json({}, 404)));
    const failed = await syncOnce(() => state({ fallbackOrigin: OLD }), telemetry, [], deps(allBad as never));
    expect(allBad).toHaveBeenCalledTimes(2);
    expect(failed).toMatchObject({ ok: false, error: "http_404" });
    expect(failed.state.failures).toBe(1);
  });

  it("drops a poison ping and blanks bad telemetry instead of getting a 400 forever", async () => {
    const fetch = vi.fn(async () => json(body()));
    const bad = [
      { ...ping, battery: -1 },
      { ...ping, heading: 400, speed: -1 },
      { ...ping, lat: 999 },
    ];
    const out = await syncOnce(() => state(), { ...telemetry, battery: -1 }, bad, deps(fetch));
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(SyncRequest.safeParse(sent).success).toBe(true);
    expect(sent.battery).toBeNull();
    expect(sent.pings).toEqual([
      { ...ping, battery: null },
      { ...ping, heading: null, speed: null },
    ]);
    expect(out.ok).toBe(true);
    expect(out.sentPings).toBe(3);
  });

  it("applies the response to the state as it is after the request, not before", async () => {
    let live = state({ config: body({ killed: true }) });
    const fetch = vi.fn(async () => {
      live = requestResume(live); // driver presses Resume mid-flight
      return json(body({ killed: true }));
    });
    const out = await syncOnce(() => live, telemetry, [], deps(fetch));
    expect(out.ok).toBe(true);
    expect(out.state.resumePending).toBe(true);
  });

  it("discards a response when the phone was re-paired mid-flight", async () => {
    let live = state();
    const fetch = vi.fn(async () => {
      live = { ...live, token: "new" };
      return json(body({ revoked: true }));
    });
    const out = await syncOnce(() => live, telemetry, [], deps(fetch));
    expect(out).toMatchObject({ ok: false, error: "superseded", sentPings: 0 });
    expect(out.state.token).toBe("new");
  });

  it("reports an unknown token without wiping it (a misrouted origin must not unpair the phone)", async () => {
    const out = await syncOnce(() => state(), telemetry, [], deps(vi.fn(async () => json({}, 401))));
    expect(out).toMatchObject({ ok: false, error: "unauthorized" });
    expect(out.state.token).toBe("tok");
  });

  it("rejects a response that does not match the contract", async () => {
    const out = await syncOnce(() => state(), telemetry, [], deps(vi.fn(async () => json({ configVersion: "x" }))));
    expect(out).toMatchObject({ ok: false, error: "invalid_response" });
    expect(out.state.config).toBeNull();
  });

  it("sends a pending resume and clears it when the server lifts the kill", async () => {
    const fetch = vi.fn(async () => json(body({ killed: false })));
    const out = await syncOnce(
      () => state({ config: body({ killed: true }), resumePending: true }),
      telemetry,
      [],
      deps(fetch),
    );
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).resume).toBe(true);
    expect(out.state.resumePending).toBe(false);
    expect(out.state.config?.killed).toBe(false);
  });
});
