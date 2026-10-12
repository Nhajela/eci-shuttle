import type { PairResponse, SyncResponse } from "@eci-shuttle/shared";
import { describe, expect, it, vi } from "vitest";
import { parseSimArgs } from "./args";
import { type SimServices, startSim } from "./start";

const T0 = Date.UTC(2026, 9, 20, 4, 0, 0);
const TEST = { id: "ws-test", slug: "test", isLive: false };
const LIVE = { id: "ws-live", slug: "live", isLive: true };
const OTHER = { id: "ws-other", slug: "other", isLive: false };
const route = {
  name: "Loop",
  path: [
    { lat: 15.65, lng: 73.7 },
    { lat: 15.67, lng: 73.7 },
  ],
  spotPathIdx: [0, 1],
  typicalLegS: [600],
};

const config = (workspace: { slug: string; isLive: boolean }): SyncResponse => ({
  configVersion: 1,
  killed: false,
  revoked: false,
  schedule: [],
  activeIntervalS: 10,
  idleHeartbeatS: 900,
  minAppVersion: null,
  apkUrl: null,
  targetUpdateId: null,
  apiOrigin: "http://x",
  serverTime: T0,
  vehicleName: null,
  workspace,
});

/** fake services over three workspaces, and a fake server that pairs the code into `pairedInto` */
function setup(slug: string, pairedInto: { slug: string; isLive: boolean }) {
  const all = [TEST, LIVE, OTHER];
  const services = {
    workspaceBySlug: vi.fn(async (s: string) => all.find((w) => w.slug === s) ?? null),
    listRoutes: vi.fn(async () => [route]),
    listVehicles: vi.fn(async () => [{ id: "veh-1", name: "Bus 1" }]),
    assignPhone: vi.fn(async () => {}),
    revokePhone: vi.fn(async () => {}),
  } satisfies SimServices;
  const pair: PairResponse = { deviceId: crypto.randomUUID(), token: "tok", config: config(pairedInto) };
  const fetch = vi.fn(async () => Response.json(pair));
  const ctrl = new AbortController();
  ctrl.abort(); // stop the replay before its first sync: these tests are about setup
  const run = () =>
    startSim(parseSimArgs([slug, "Bus 1", "123456"]), {
      origin: "http://x",
      services,
      deps: { fetch: fetch as unknown as typeof globalThis.fetch, now: () => T0, sleep: async () => {}, log: () => {} },
      signal: ctrl.signal,
    });
  return { services, fetch, pair, run };
}

describe("startSim", () => {
  it("refuses the live workspace before pairing anything", async () => {
    const s = setup("live", LIVE);
    await expect(s.run()).rejects.toThrow(/never in the live one/);
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.services.assignPhone).not.toHaveBeenCalled();
  });

  it("undoes the pairing when the code was made in the live workspace", async () => {
    const s = setup("test", LIVE);
    await expect(s.run()).rejects.toThrow(/pairing was undone/);
    expect(s.services.revokePhone).toHaveBeenCalledWith({ workspaceId: LIVE.id, deviceId: s.pair.deviceId });
    expect(s.services.assignPhone).not.toHaveBeenCalled();
  });

  it("undoes the pairing when the code belongs to another test workspace", async () => {
    const s = setup("test", OTHER);
    await expect(s.run()).rejects.toThrow(/belongs to "other"/);
    expect(s.services.revokePhone).toHaveBeenCalledWith({ workspaceId: OTHER.id, deviceId: s.pair.deviceId });
    expect(s.services.assignPhone).not.toHaveBeenCalled();
  });

  it("pairs, assigns the sim to the vehicle, then replays", async () => {
    const s = setup("test", TEST);
    expect(await s.run()).toBe("stopped");
    expect(s.services.assignPhone).toHaveBeenCalledWith({
      workspaceId: TEST.id,
      deviceId: s.pair.deviceId,
      vehicleId: "veh-1",
    });
    expect(s.services.revokePhone).not.toHaveBeenCalled();
  });
});
