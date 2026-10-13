import type { SyncResponse, Window } from "@eci-shuttle/shared";
import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog } from "@/db/schema";
import { bumpConfigs, desiredConfig } from "@/services/devices/config";
import { trackedDevices } from "@/services/devices/phones";
import { refreshPhases } from "@/services/ingest/ingest";
import { windows } from "./windows";

vi.mock("@/services/devices/config", () => ({ desiredConfig: vi.fn(), bumpConfigs: vi.fn() }));
vi.mock("@/services/devices/phones", () => ({ trackedDevices: vi.fn() }));
vi.mock("@/services/ingest/ingest", () => ({ refreshPhases: vi.fn() }));

const NOW = new Date("2026-10-12T04:10:00.300Z");
const MIN = 60_000;
const t = NOW.getTime();
const FLOOR = Math.floor(t / MIN) * MIN; // the tick's range ends on the whole minute

const win = (startsAt: number, endsAt: number, mode: Window["mode"] = "active"): Window => ({
  startsAt,
  endsAt,
  mode,
  intervalS: null,
  source: "service",
  label: null,
});
const phone = (id: string) => ({ deviceId: id, vehicleId: `v-${id}` });

/** device id → its schedule */
let schedules: Record<string, Window[]>;
let phonesByWs: Record<string, ReturnType<typeof phone>[]>;

beforeEach(() => {
  vi.clearAllMocks();
  schedules = {};
  phonesByWs = {};
  vi.mocked(trackedDevices).mockImplementation(async (_db, workspaceId) => phonesByWs[workspaceId] ?? []);
  vi.mocked(desiredConfig).mockImplementation(
    async (_db, deviceId) => ({ killed: false, revoked: false, schedule: schedules[deviceId] ?? [] }) as SyncResponse,
  );
  vi.mocked(bumpConfigs).mockImplementation(async (_db, target) => target.deviceIds ?? []);
  vi.mocked(refreshPhases).mockResolvedValue([]);
});

const run = (now = NOW) => windows.run({ db: testDb(), now, workerId: "w", startedAt: now, log: () => {} });
const bumpAudits = (workspaceId: string) =>
  testDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.action, "device.config_bump")));

describe("windows job", () => {
  it("bumps phones whose window opened or closed in the last minute, audited once per workspace", async () => {
    const ws = await makeWorkspace(testDb());
    phonesByWs[ws.id] = [phone("opened"), phone("closed"), phone("steady"), phone("later")];
    schedules = {
      opened: [win(t - 30_000, t + 60 * MIN)],
      closed: [win(t - 60 * MIN, t - 20_000)],
      steady: [win(t - 2 * MIN, t + 60 * MIN)],
      later: [win(t + 5 * MIN, t + 60 * MIN)],
    };

    await run();

    expect(bumpConfigs).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bumpConfigs).mock.calls[0][1]).toEqual({ deviceIds: ["opened", "closed"] });
    // the config is read at the range start so a window that just closed is still in it
    expect(desiredConfig).toHaveBeenCalledWith(expect.anything(), "opened", new Date(FLOOR - MIN));
    const audits = await bumpAudits(ws.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: "system", actorId: "windows", entity: "device" });
    expect(audits[0].after).toEqual({ deviceIds: ["opened", "closed"] });
    expect(refreshPhases).toHaveBeenCalledWith(expect.anything(), ws.id, NOW);
  });

  it("counts a silence starting as a change too", async () => {
    const ws = await makeWorkspace(testDb());
    phonesByWs[ws.id] = [phone("silenced")];
    schedules = { silenced: [win(t - 60 * MIN, t + 60 * MIN), win(t - 10_000, t + 10 * MIN, "idle")] };
    await run();
    expect(vi.mocked(bumpConfigs).mock.calls[0][1]).toEqual({ deviceIds: ["silenced"] });
  });

  it("an edge on the previous whole minute belongs to the previous tick", async () => {
    const ws = await makeWorkspace(testDb());
    phonesByWs[ws.id] = [phone("edge")];
    schedules = { edge: [win(FLOOR - MIN, t + 60 * MIN)] };
    await run();
    expect(bumpConfigs).not.toHaveBeenCalled();
  });

  it("no tracked phones: no bump means no audit, but phases still refresh", async () => {
    const ws = await makeWorkspace(testDb());
    await run();
    expect(desiredConfig).not.toHaveBeenCalled();
    expect(bumpConfigs).not.toHaveBeenCalled();
    expect(await bumpAudits(ws.id)).toHaveLength(0);
    expect(refreshPhases).toHaveBeenCalledWith(expect.anything(), ws.id, NOW);
  });

  it("skips killed phones", async () => {
    const ws = await makeWorkspace(testDb());
    phonesByWs[ws.id] = [phone("dead")];
    vi.mocked(desiredConfig).mockResolvedValue({
      killed: true,
      revoked: false,
      schedule: [win(t - 5_000, t + MIN)],
    } as SyncResponse);
    await run();
    expect(bumpConfigs).not.toHaveBeenCalled();
  });

  it("one workspace failing does not stop the others", async () => {
    const bad = await makeWorkspace(testDb());
    const good = await makeWorkspace(testDb());
    phonesByWs[good.id] = [phone("ok")];
    schedules = { ok: [win(t - 5_000, t + MIN)] };
    vi.mocked(trackedDevices).mockImplementation(async (_db, workspaceId) => {
      if (workspaceId === bad.id) throw new Error("boom");
      return phonesByWs[workspaceId] ?? [];
    });
    await expect(run()).rejects.toThrow(/boom/);
    expect(await bumpAudits(good.id)).toHaveLength(1);
  });

  it("catches up the edges of a skipped tick", async () => {
    const ws = await makeWorkspace(testDb());
    phonesByWs[ws.id] = [phone("late")];
    const T = FLOOR + 5 * MIN + 400;
    schedules = { late: [win(T + 30_000, T + 60 * MIN)] }; // opens in the T+1 tick's minute
    await run(new Date(T));
    expect(bumpConfigs).not.toHaveBeenCalled();
    // the T+1 tick never runs
    await run(new Date(T + 2 * MIN));
    expect(vi.mocked(bumpConfigs).mock.calls[0][1]).toEqual({ deviceIds: ["late"] });
    expect(desiredConfig).toHaveBeenLastCalledWith(expect.anything(), "late", new Date(FLOOR + 5 * MIN));
  });
});
