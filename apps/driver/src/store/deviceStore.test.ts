import type { SyncResponse } from "@eci-shuttle/shared/contracts";
import { describe, expect, it } from "vitest";
import { createDeviceStore } from "./deviceStore";
import { memoryKV } from "./kv";

const BUILT_IN = "https://eci-shuttle.positivesumcompany.com";

const resp = (over: Partial<SyncResponse> = {}): SyncResponse => ({
  configVersion: 1,
  killed: false,
  revoked: false,
  schedule: [],
  activeIntervalS: 10,
  idleHeartbeatS: 900,
  minAppVersion: null,
  apkUrl: null,
  targetUpdateId: null,
  apiOrigin: BUILT_IN,
  serverTime: 1_000,
  vehicleName: "Bus 1",
  workspace: { slug: "live", isLive: true },
  ...over,
});

function setup() {
  const files = memoryKV();
  const secure = memoryKV();
  return { files, secure, store: createDeviceStore({ files, secure, builtInOrigin: BUILT_IN }) };
}

describe("device store: pairing + token", () => {
  it("is unpaired with no token: deviceConfig null, built-in origin only", async () => {
    const { store } = setup();
    expect(await store.token()).toBeNull();
    expect(await store.deviceConfig()).toBeNull();
    expect(await store.origins()).toEqual([BUILT_IN]);
  });

  it("pairing keeps the token in secure storage and the config on disk", async () => {
    const { store, secure, files } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp({ configVersion: 3 }) });
    expect(await store.token()).toBe("tok");
    expect(JSON.stringify(files.dump())).not.toContain("tok");
    expect(Object.values(secure.dump())).toContain("tok");
    expect((await store.deviceConfig())?.configVersion).toBe(3);
  });

  it("survives a restart (new store over the same storage)", async () => {
    const { store, files, secure } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp({ configVersion: 4 }) });
    const again = createDeviceStore({ files, secure, builtInOrigin: BUILT_IN });
    expect(await again.token()).toBe("tok");
    expect((await again.deviceConfig())?.configVersion).toBe(4);
  });

  it("treats corrupt state on disk as unpaired instead of crashing", async () => {
    const { store, files } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp() });
    for (const k of Object.keys(files.dump())) await files.set(k, "{not json");
    expect(await store.deviceConfig()).toBeNull();
  });

  it("a config with a token missing (secure storage wiped) is unpaired", async () => {
    const { store, secure } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp() });
    for (const k of Object.keys(secure.dump())) await secure.del(k);
    expect(await store.deviceConfig()).toBeNull();
  });
});

describe("device store: sync responses", () => {
  it("stores each new config", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp() });
    await store.applySync(resp({ configVersion: 2, schedule: [] }), { sentResume: false });
    expect((await store.deviceConfig())?.configVersion).toBe(2);
    expect((await store.state()).config?.vehicleName).toBe("Bus 1");
  });

  it("revoke wipes the token but keeps the phone in revoked mode until re-paired", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp() });
    await store.applySync(resp({ revoked: true }), { sentResume: false });
    expect(await store.token()).toBeNull();
    expect((await store.deviceConfig())?.revoked).toBe(true);
    await store.paired({ deviceId: "d2", token: "tok2", config: resp() });
    expect(await store.token()).toBe("tok2");
    expect((await store.deviceConfig())?.revoked).toBe(false);
  });
});

describe("device store: latched kill (SPEC §4: only Resume clears it)", () => {
  it("latches a server kill", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp() });
    await store.applySync(resp({ killed: true }), { sentResume: false });
    expect((await store.deviceConfig())?.killed).toBe(true);
  });

  it("stays killed when the server later says not killed, until the driver presses Resume", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp() });
    await store.applySync(resp({ killed: true }), { sentResume: false });
    await store.applySync(resp({ killed: false }), { sentResume: false });
    expect((await store.deviceConfig())?.killed).toBe(true);
  });

  it("Resume clears the latch at once (works offline) and marks a resume to send", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp({ killed: true }) });
    expect((await store.deviceConfig())?.killed).toBe(true);
    await store.resume();
    expect((await store.deviceConfig())?.killed).toBe(false);
    expect((await store.state()).resumePending).toBe(true);
    // a stale response from a sync sent before Resume must not re-latch
    await store.applySync(resp({ killed: true }), { sentResume: false });
    expect((await store.deviceConfig())?.killed).toBe(false);
    expect((await store.state()).resumePending).toBe(true);
  });

  it("the response to the resume sync settles it", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp({ killed: true }) });
    await store.resume();
    await store.applySync(resp({ killed: false }), { sentResume: true });
    expect((await store.state()).resumePending).toBe(false);
    expect((await store.deviceConfig())?.killed).toBe(false);
    // a new kill after that latches again
    await store.applySync(resp({ killed: true }), { sentResume: false });
    expect((await store.deviceConfig())?.killed).toBe(true);
  });

  it("re-latches when the server still says killed in answer to the resume", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp({ killed: true }) });
    await store.resume();
    await store.applySync(resp({ killed: true }), { sentResume: true });
    expect((await store.deviceConfig())?.killed).toBe(true);
  });

  it("a kill latched on disk survives a restart", async () => {
    const { store, files, secure } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp() });
    await store.applySync(resp({ killed: true }), { sentResume: false });
    const again = createDeviceStore({ files, secure, builtInOrigin: BUILT_IN });
    expect((await again.deviceConfig())?.killed).toBe(true);
  });
});

describe("device store: apiOrigin with fallback (SPEC §2a)", () => {
  it("uses the server's apiOrigin first, then the previous one, then the built-in domain", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp({ apiOrigin: "https://a.example" }) });
    expect(await store.origins()).toEqual(["https://a.example", BUILT_IN]);
    await store.applySync(resp({ apiOrigin: "https://b.example" }), { sentResume: false });
    expect(await store.origins()).toEqual(["https://b.example", "https://a.example", BUILT_IN]);
  });

  it("an unchanged apiOrigin keeps the fallback", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp({ apiOrigin: "https://a.example" }) });
    await store.applySync(resp({ apiOrigin: "https://b.example" }), { sentResume: false });
    await store.applySync(resp({ apiOrigin: "https://b.example" }), { sentResume: false });
    expect(await store.origins()).toEqual(["https://b.example", "https://a.example", BUILT_IN]);
  });

  it("strips a trailing slash so callers can append /api/device/sync", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp({ apiOrigin: "https://a.example/" }) });
    expect(await store.origins()).toEqual(["https://a.example", BUILT_IN]);
  });

  it("concurrent writes don't lose updates", async () => {
    const { store } = setup();
    await store.paired({ deviceId: "d", token: "tok", config: resp() });
    await Promise.all([
      store.applySync(resp({ killed: true }), { sentResume: false }),
      store.applySync(resp({ configVersion: 9 }), { sentResume: false }),
    ]);
    const c = await store.deviceConfig();
    expect(c?.killed).toBe(true);
    expect(c?.configVersion).toBe(9);
  });
});
