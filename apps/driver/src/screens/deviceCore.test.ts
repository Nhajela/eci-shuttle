import type { PairResponse, SyncResponse } from "@eci-shuttle/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDeviceStore } from "../store/deviceStore";
import { memoryKV } from "../store/kv";
import { buildSyncRequest, initialSyncState, type SyncState } from "../sync/sync";
import { createScreenDevice } from "./deviceCore";

const NOW = Date.UTC(2026, 9, 14, 4, 0);
const ORIGIN = "https://eci-shuttle.example.com";
const DEVICE_ID = "0b9f3c2e-6a51-4c1e-9d0a-2f6c1b7e8a44";

const config = (over: Partial<SyncResponse> = {}): SyncResponse => ({
  configVersion: 3,
  killed: false,
  revoked: false,
  // a full day of windows: far over SecureStore's 2048-byte value limit once serialised
  schedule: Array.from({ length: 40 }, (_, i) => ({
    startsAt: NOW + i * 1_800_000,
    endsAt: NOW + (i + 1) * 1_800_000,
    mode: "active" as const,
    intervalS: null,
    source: "service" as const,
    label: `Riva ↔ Circle run ${i}`,
  })),
  activeIntervalS: 10,
  idleHeartbeatS: 900,
  minAppVersion: null,
  apkUrl: null,
  targetUpdateId: null,
  apiOrigin: ORIGIN,
  serverTime: NOW,
  vehicleName: "Van 2",
  workspace: { slug: "live", isLive: true },
  ...over,
});

function setup() {
  const files = memoryKV();
  const secure = memoryKV();
  const store = createDeviceStore({ files, secure, builtInOrigin: ORIGIN, queue: { clear: async () => {} } });
  const syncNow = vi.fn(async () => {});
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ deviceId: DEVICE_ID, token: "tok-123", config: config() } satisfies PairResponse),
  );
  const dev = createScreenDevice({ store, files, syncNow, fetch, builtInOrigin: ORIGIN });
  return { files, secure, store, syncNow, fetch, dev };
}

const INFO = { model: "Xiaomi Redmi 12", appVersion: "1.0.0", updateId: null };

describe("pair", () => {
  it("posts the code and stores the response through store.paired: token in SecureStore, config on disk", async () => {
    const { dev, fetch, files, secure, store } = setup();
    await dev.pair("123456", null, INFO);
    expect(fetch.mock.calls[0][0]).toBe(`${ORIGIN}/api/device/pair`);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ code: "123456", pushToken: null });
    expect(await store.token()).toBe("tok-123");
    expect(secure.dump()).toEqual({ "device-token": "tok-123" });
    expect(JSON.stringify(files.dump())).not.toContain("tok-123");
    expect((await dev.load()).deviceConfig?.configVersion).toBe(3);
  });

  it("uses the origin from the QR when there is one", async () => {
    const { dev, fetch } = setup();
    await dev.pair("123456", "https://staging.example.com", INFO);
    expect(fetch.mock.calls[0][0]).toBe("https://staging.example.com/api/device/pair");
  });

  it("gives the driver a readable error for an expired code and stores nothing", async () => {
    const { dev, fetch, store } = setup();
    fetch.mockResolvedValueOnce(new Response("{}", { status: 410 }));
    await expect(dev.pair("123456", null, INFO)).rejects.toThrow(/expired/);
    expect(await store.deviceConfig()).toBeNull();
  });
});

describe("resume", () => {
  it("clears the latched kill, marks resume pending and triggers a sync that carries resume: true", async () => {
    const { dev, store, syncNow } = setup();
    await store.paired({ deviceId: DEVICE_ID, token: "tok", config: config({ killed: true }) });
    expect((await dev.load()).deviceConfig?.killed).toBe(true);

    await dev.resume();

    expect((await store.deviceConfig())?.killed).toBe(false);
    expect((await store.state()).resumePending).toBe(true);
    expect(syncNow).toHaveBeenCalledTimes(1);
    const sync: SyncState = {
      ...initialSyncState(ORIGIN),
      token: "tok",
      resumePending: (await store.state()).resumePending,
    };
    const req = buildSyncRequest(sync, {} as never, [], NOW);
    expect(req.resume).toBe(true);
  });

  it("a failing sync does not undo the resume (it is retried by the background sync)", async () => {
    const { dev, store, syncNow } = setup();
    await store.paired({ deviceId: DEVICE_ID, token: "tok", config: config({ killed: true }) });
    syncNow.mockRejectedValueOnce(new Error("offline"));
    await dev.resume();
    expect((await store.state()).resumePending).toBe(true);
  });
});

describe("load: runtime flags", () => {
  it("reads the last sync error and the open-the-app flag the runtime wrote", async () => {
    const { dev, files } = setup();
    expect((await dev.load()).runtime).toEqual({ lastError: null, needsApp: false });
    await files.set("sync-state", JSON.stringify({ lastError: "http_429", needsApp: true }));
    expect((await dev.load()).runtime).toEqual({ lastError: "http_429", needsApp: true });
  });
});

describe("load", () => {
  it("shows the latched kill, not the last response", async () => {
    const { dev, store } = setup();
    await store.paired({ deviceId: DEVICE_ID, token: "tok", config: config() });
    await store.applySync(config({ killed: true }), { sentResume: false });
    await store.applySync(config({ killed: false }), { sentResume: false });
    const snap = await dev.load();
    expect(snap.config?.killed).toBe(false);
    expect(snap.deviceConfig?.killed).toBe(true);
  });

  it("keeps consent and setup in the same file KV, across restarts", async () => {
    const { dev, files, secure } = setup();
    await dev.acceptConsent(NOW);
    await dev.finishSetup(NOW + 1);
    const again = createScreenDevice({
      store: createDeviceStore({ files, secure, builtInOrigin: ORIGIN, queue: { clear: async () => {} } }),
      files,
      syncNow: async () => {},
      fetch: async () => new Response(),
      builtInOrigin: ORIGIN,
    });
    expect(await again.load()).toMatchObject({ consentAt: NOW, setupDoneAt: NOW + 1, deviceConfig: null });
  });

  it("reads the sync clock offset and last sync, defaulting to none", async () => {
    const { dev, files } = setup();
    expect((await dev.load()).sync).toMatchObject({ clockOffsetMs: 0, lastSyncAt: null });
    await files.set(
      "sync-state",
      JSON.stringify({ ...initialSyncState(ORIGIN), clockOffsetMs: 90_000, lastSyncAt: NOW }),
    );
    expect((await dev.load()).sync).toMatchObject({ clockOffsetMs: 90_000, lastSyncAt: NOW });
  });
});
