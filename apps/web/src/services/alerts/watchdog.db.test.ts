import { istToEpoch, type SyncResponse, type Window } from "@eci-shuttle/shared";
import { makeAssignedDevice, makeDevice } from "@tests/factories/alerts";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { devices, outbox } from "@/db/schema";
import { refreshPhases } from "@/services/ingest/ingest";
import type { TelegramPayload } from "../kernel";
import { detectProblems, runWatchdog } from "./watchdog";

// Other tasks' modules (config, resolveMode, ingest, bot callbacks) are faked to their documented contracts.
const schedules = new Map<string, Window[]>();
vi.mock("@/services/devices/config", () => ({
  desiredConfig: vi.fn(
    async (_db: unknown, deviceId: string) =>
      ({
        killed: false,
        revoked: false,
        schedule: schedules.get(deviceId) ?? [],
        activeIntervalS: 10,
        idleHeartbeatS: 900,
      }) as unknown as SyncResponse,
  ),
}));
vi.mock("@eci-shuttle/shared", async (orig) => ({
  ...(await orig<typeof import("@eci-shuttle/shared")>()),
  resolveMode: (c: SyncResponse | null, now: number) => {
    if (!c) return { mode: "unpaired", window: null };
    if (c.revoked) return { mode: "revoked", window: null };
    if (c.killed) return { mode: "killed", window: null };
    const w = c.schedule.find((x) => x.startsAt <= now && now < x.endsAt) ?? null;
    return { mode: w?.mode ?? "idle", window: w };
  },
}));
vi.mock("@/services/ingest/ingest", () => ({ refreshPhases: vi.fn(async () => []) }));

const db = () => testDb();
const NOW = new Date(istToEpoch("2026-10-12", "09:40"));
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const activeSince = (min: number): Window[] => [
  {
    startsAt: ago(min).getTime(),
    endsAt: NOW.getTime() + 3_600_000,
    mode: "active",
    intervalS: null,
    source: "service",
    label: null,
  },
];
const OK = { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true } as const;

beforeEach(() => schedules.clear());

describe("detectProblems", () => {
  it("silent: inside a window with the last ping over 5 min ago, since max(last ping, window start)", async () => {
    const ws = await makeWorkspace(db());
    const silent = await makeAssignedDevice(db(), ws.id, { state: { lastPingAt: ago(6) } });
    const fresh = await makeAssignedDevice(db(), ws.id, { vehicle: { name: "Bus 2" }, state: { lastPingAt: ago(4) } });
    const justStarted = await makeAssignedDevice(db(), ws.id, { vehicle: { name: "Bus 3" } });
    const neverPinged = await makeAssignedDevice(db(), ws.id, { vehicle: { name: "Bus 4" } });
    await makeAssignedDevice(db(), ws.id, { vehicle: { name: "Bus 5" }, state: { lastPingAt: ago(60) } });
    schedules.set(silent.device.id, activeSince(30));
    schedules.set(fresh.device.id, activeSince(30));
    schedules.set(justStarted.device.id, activeSince(3));
    schedules.set(neverPinged.device.id, activeSince(20));

    const problems = await detectProblems(db(), ws.id, NOW);
    expect(problems).toHaveLength(2);
    expect(problems).toContainEqual({
      kind: "silent",
      workspaceId: ws.id,
      vehicleId: silent.vehicle.id,
      deviceId: silent.device.id,
      since: ago(6),
      message: "Bus 1 has been silent",
    });
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: "silent", vehicleId: neverPinged.vehicle.id, since: ago(20) }),
    );
  });

  it("off_route while on duty, since off_route_since (else the phase start)", async () => {
    const ws = await makeWorkspace(db());
    const { vehicle, device } = await makeAssignedDevice(db(), ws.id, {
      state: { offRoute: true, phase: "en_route", since: ago(9), offRouteSince: ago(3), lastPingAt: ago(0) },
    });
    await makeAssignedDevice(db(), ws.id, { vehicle: { name: "Bus 2" }, state: { offRoute: true, phase: "off_duty" } });
    expect(await detectProblems(db(), ws.id, NOW)).toEqual([
      {
        kind: "off_route",
        workspaceId: ws.id,
        vehicleId: vehicle.id,
        deviceId: device.id,
        since: ago(3),
        message: "Bus 1 is off its route",
      },
    ]);
  });

  it("low_battery below 15% and not charging, since devices.low_battery_since (now when not stamped yet)", async () => {
    const ws = await makeWorkspace(db());
    const low = await makeDevice(db(), ws.id, { battery: 12, charging: false, lowBatterySince: ago(20) });
    await makeDevice(db(), ws.id, { label: "Charging", battery: 5, charging: true });
    await makeDevice(db(), ws.id, { label: "Fine", battery: 15, charging: false });
    const fresh = await makeDevice(db(), ws.id, { label: "Asha's phone", battery: 9, charging: null });

    const problems = await detectProblems(db(), ws.id, NOW);
    expect(problems).toHaveLength(2);
    expect(problems).toContainEqual({
      kind: "low_battery",
      workspaceId: ws.id,
      vehicleId: null,
      deviceId: low.id,
      since: ago(20),
      message: "Ravi's phone is at 12% battery",
    });
    expect(problems).toContainEqual(expect.objectContaining({ deviceId: fresh.id, since: NOW }));
  });

  it("permission_lost when location isn't 'always' or notifications are off", async () => {
    const ws = await makeWorkspace(db());
    const d = await makeDevice(db(), ws.id, {
      permissions: { ...OK, location: "foreground", notifications: false },
      permissionLostSince: ago(8),
    });
    await makeDevice(db(), ws.id, { label: "OK", permissions: OK });
    const fresh = await makeDevice(db(), ws.id, { label: "New", permissions: { ...OK, notifications: false } });
    const problems = await detectProblems(db(), ws.id, NOW);
    expect(problems).toContainEqual(expect.objectContaining({ deviceId: fresh.id, since: NOW }));
    expect(problems.filter((p) => p.deviceId !== fresh.id)).toEqual([
      {
        kind: "permission_lost",
        workspaceId: ws.id,
        vehicleId: null,
        deviceId: d.id,
        since: ago(8),
        message: "Ravi's phone: location isn't set to 'Allow all the time', notifications are off",
      },
    ]);
  });

  it("mode_mismatch: kill pending, reported ≠ desired after a sync, config behind > 2 min after the push", async () => {
    const ws = await makeWorkspace(db());
    // synced after the kill on the kill's config version and still reports active
    const killed = await makeDevice(db(), ws.id, {
      label: "K",
      killedAt: ago(5),
      reportedMode: "active",
      lastSyncAt: ago(1),
      configVersion: 2,
      reportedConfigVersion: 2,
    });
    await makeDevice(db(), ws.id, { label: "K done", killedAt: ago(5), reportedMode: "killed", lastSyncAt: ago(1) });
    const wrong = await makeAssignedDevice(db(), ws.id, {
      device: { label: "W", reportedMode: "idle", lastSyncAt: ago(1), reportedConfigVersion: 1 },
      state: { lastPingAt: ago(1) },
    });
    // an idle phone gets two idle heartbeats (2 × 15 min) to wake up
    schedules.set(wrong.device.id, activeSince(40));
    const notSynced = await makeAssignedDevice(db(), ws.id, {
      vehicle: { name: "Bus 2" },
      device: { label: "N", reportedMode: "idle", lastSyncAt: ago(11) },
      state: { lastPingAt: ago(1) },
    });
    schedules.set(notSynced.device.id, activeSince(10));
    const active = { reportedMode: "active", configVersion: 3, reportedConfigVersion: 2 } as const;
    const behind = await makeDevice(db(), ws.id, { label: "B", ...active });
    const behindNew = await makeDevice(db(), ws.id, { label: "B new", ...active });
    await db()
      .insert(outbox)
      .values([
        { workspaceId: ws.id, kind: "push", payload: {}, dedupeKey: `push:${behind.id}:3`, createdAt: ago(3) },
        { workspaceId: ws.id, kind: "push", payload: {}, dedupeKey: `push:${behindNew.id}:3`, createdAt: ago(1) },
      ]);

    const problems = await detectProblems(db(), ws.id, NOW);
    expect(problems.map((p) => [p.kind, p.deviceId, p.since])).toEqual(
      expect.arrayContaining([
        ["mode_mismatch", killed.id, ago(5)],
        ["mode_mismatch", wrong.device.id, ago(40)],
        ["mode_mismatch", behind.id, ago(3)],
      ]),
    );
    expect(problems).toHaveLength(3);
    expect(problems.find((p) => p.deviceId === killed.id)?.message).toBe("K was killed but still reports active");
    expect(problems.find((p) => p.deviceId === wrong.device.id)?.message).toBe("W reports idle but should be active");
    expect(problems.find((p) => p.deviceId === behind.id)?.message).toBe("B hasn't picked up its new settings");
  });

  it("mode_mismatch compares the report with what the phone was told at its last sync", async () => {
    const ws = await makeWorkspace(db());
    const ended = (min: number): Window[] => [{ ...activeSince(60)[0], endsAt: ago(min).getTime() }];
    // window ended 1 min ago; the phone synced inside it reporting active: it was right
    const synced = { reportedMode: "active", reportedConfigVersion: 1 } as const;
    const justEnded = await makeDevice(db(), ws.id, { label: "J", ...synced, lastSyncAt: ago(2) });
    schedules.set(justEnded.id, ended(1));
    // window ended 10 min ago; the phone synced since then and still reports active
    const stuck = await makeDevice(db(), ws.id, { label: "S", ...synced, lastSyncAt: ago(1) });
    schedules.set(stuck.id, ended(10));

    expect(await detectProblems(db(), ws.id, NOW)).toEqual([
      {
        kind: "mode_mismatch",
        workspaceId: ws.id,
        vehicleId: null,
        deviceId: stuck.id,
        since: ago(10),
        message: "S reports active but should be idle",
      },
    ]);
  });

  it("a killed phone that stopped syncing, or only synced its old config, is not a kill pending", async () => {
    const ws = await makeWorkspace(db());
    const k = { killedAt: ago(5), reportedMode: "active", configVersion: 2 } as const;
    // last sync before the kill; then it stopped syncing
    await makeDevice(db(), ws.id, { ...k, lastSyncAt: ago(6), reportedConfigVersion: 1 });
    // synced once after the kill, reporting its state from before it applied the kill
    await makeDevice(db(), ws.id, { ...k, lastSyncAt: ago(4), reportedConfigVersion: 1 });
    // killed while idle: synced after the kill on the new config, reporting idle
    await makeDevice(db(), ws.id, { ...k, reportedMode: "idle", lastSyncAt: ago(1), reportedConfigVersion: 2 });
    await makeDevice(db(), ws.id, { ...k, lastSyncAt: null, reportedConfigVersion: null });
    expect(await detectProblems(db(), ws.id, NOW)).toEqual([]);
  });

  it("mode_mismatch waits for the phone to apply a changed config, and never dates it from midnight", async () => {
    const ws = await makeWorkspace(db());
    const push = (deviceId: string, v: number, min: number) => ({
      workspaceId: ws.id,
      kind: "push" as const,
      payload: {},
      dedupeKey: `push:${deviceId}:${v}`,
      createdAt: ago(min),
    });
    // moved off its vehicle (config 2, now idle) since its last sync on config 1, where it was active
    const moved = await makeDevice(db(), ws.id, {
      reportedMode: "active",
      lastSyncAt: ago(1),
      configVersion: 2,
      reportedConfigVersion: 1,
    });
    // idle phone, config pushed 3 min ago: it gets two idle heartbeats before "hasn't picked up"
    const idleBehind = await makeDevice(db(), ws.id, {
      reportedMode: "idle",
      lastSyncAt: ago(10),
      configVersion: 2,
      reportedConfigVersion: 1,
    });
    // on its current config with no windows and no known change time: no "since 00:00"
    await makeDevice(db(), ws.id, { reportedMode: "active", lastSyncAt: ago(1), reportedConfigVersion: 1 });
    // applied a config pushed 1 min ago that made it idle: too soon
    const fresh = await makeDevice(db(), ws.id, {
      reportedMode: "active",
      lastSyncAt: ago(0),
      configVersion: 2,
      reportedConfigVersion: 2,
    });
    await db()
      .insert(outbox)
      .values([push(moved.id, 2, 0.5), push(idleBehind.id, 2, 3), push(fresh.id, 2, 1)]);
    expect(await detectProblems(db(), ws.id, NOW)).toEqual([]);

    // much later the idle phone still hasn't picked it up; the moved phone synced on its new config, still active
    const later = new Date(NOW.getTime() + 31 * 60_000);
    await db().update(devices).set({ lastSyncAt: later, reportedConfigVersion: 2 }).where(eq(devices.id, moved.id));
    const problems = await detectProblems(db(), ws.id, later);
    expect(problems.map((p) => [p.deviceId, p.since, p.message])).toEqual(
      expect.arrayContaining([
        [moved.id, ago(0.5), "Ravi's phone reports active but should be idle"],
        [idleBehind.id, ago(3), "Ravi's phone hasn't picked up its new settings"],
      ]),
    );
    expect(problems.filter((p) => p.deviceId !== fresh.id)).toHaveLength(2);
  });

  it("update_failed when the phone isn't running its target after a failed update; revoked phones are ignored", async () => {
    const ws = await makeWorkspace(db(), { targetUpdateId: "u2" });
    const failed = await makeDevice(db(), ws.id, { updateId: "u1", updateFailedAt: ago(7) });
    await makeDevice(db(), ws.id, { label: "Recovered", updateId: "u2", updateFailedAt: ago(7) });
    await makeDevice(db(), ws.id, { label: "Override", targetUpdateId: "u1", updateId: "u1", updateFailedAt: ago(7) });
    await makeDevice(db(), ws.id, { label: "Gone", revokedAt: ago(1), battery: 3, charging: false });
    expect(await detectProblems(db(), ws.id, NOW)).toEqual([
      {
        kind: "update_failed",
        workspaceId: ws.id,
        vehicleId: null,
        deviceId: failed.id,
        since: ago(7),
        message: "Ravi's phone failed to install the app update",
      },
    ]);
  });

  it("update_pending when the phone synced > 2 min after the target was pushed but isn't running it", async () => {
    const ws = await makeWorkspace(db(), { targetUpdateId: "u2" });
    const pending = await makeDevice(db(), ws.id, {
      configVersion: 4,
      reportedConfigVersion: 4,
      updateId: "u1",
      lastSyncAt: ago(1),
    });
    const synced = { configVersion: 4, reportedConfigVersion: 4, updateId: "u1" };
    const soon = await makeDevice(db(), ws.id, { label: "Soon", ...synced, lastSyncAt: ago(4) });
    const done = await makeDevice(db(), ws.id, { label: "Done", ...synced, updateId: "u2", lastSyncAt: ago(1) });
    await db()
      .insert(outbox)
      .values(
        [pending, soon, done].map((d) => ({
          workspaceId: ws.id,
          kind: "push" as const,
          payload: {},
          dedupeKey: `push:${d.id}:4`,
          createdAt: ago(5),
        })),
      );
    expect(await detectProblems(db(), ws.id, NOW)).toEqual([
      {
        kind: "update_pending",
        workspaceId: ws.id,
        vehicleId: null,
        deviceId: pending.id,
        since: ago(5),
        message: "Ravi's phone hasn't installed the app update",
      },
    ]);
  });
});

describe("runWatchdog", () => {
  it("refreshes phases, alerts each problem once per episode with buttons, and admin changes", async () => {
    const ws = await makeWorkspace(db());
    const { person } = await makeAdmin(db(), ws.id);
    const { device, vehicle } = await makeAssignedDevice(db(), ws.id, { state: { lastPingAt: ago(6) } });
    schedules.set(device.id, activeSince(30));

    const r = await runWatchdog(db(), NOW);
    expect(r.workspaces).toBeGreaterThanOrEqual(1);
    expect(r.problems).toBeGreaterThanOrEqual(1);
    expect(refreshPhases).toHaveBeenCalledWith(expect.anything(), ws.id, NOW);

    const jobs = await db().select().from(outbox).where(eq(outbox.workspaceId, ws.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupeKey).toBe(`alert:silent:${vehicle.id}:${ago(6).getTime()}:${person.id}`);
    const payload = jobs[0].payload as TelegramPayload;
    expect(payload.html).toContain("Bus 1 has been silent");
    expect(payload.html).toContain("09:34");
    expect(payload.buttons).toEqual([
      [
        { text: "Nudge phone", callbackData: `nudge:${device.id}` },
        { text: "Silence 1h", callbackData: `sil1h:${device.id}` },
      ],
      [{ text: "Open in admin", url: `http://localhost:3000/admin/live?w=${ws.slug}` }],
    ]);

    await runWatchdog(db(), new Date(NOW.getTime() + 60_000));
    expect(await db().select().from(outbox).where(eq(outbox.workspaceId, ws.id))).toHaveLength(1);
  });

  it("one workspace failing does not stop the others", async () => {
    const bad = await makeWorkspace(db());
    const ws = await makeWorkspace(db());
    await makeAdmin(db(), ws.id);
    const { device } = await makeAssignedDevice(db(), ws.id, { state: { lastPingAt: ago(6) } });
    schedules.set(device.id, activeSince(30));
    vi.mocked(refreshPhases).mockImplementation(async (_db, id) => {
      if (id === bad.id) throw new Error("odd data");
      return [];
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let logged: unknown[][];
    try {
      await runWatchdog(db(), NOW);
    } finally {
      logged = [...err.mock.calls];
      vi.mocked(refreshPhases).mockImplementation(async () => []);
      err.mockRestore();
    }
    expect(logged).toContainEqual([expect.stringContaining(bad.id), expect.any(Error)]);
    expect(await db().select().from(outbox).where(eq(outbox.workspaceId, ws.id))).toHaveLength(1);
  });

  it("keys phone problems on the phone, so a swapped-in phone on the same vehicle still alerts", async () => {
    const ws = await makeWorkspace(db());
    const { person } = await makeAdmin(db(), ws.id);
    const { device } = await makeAssignedDevice(db(), ws.id, {
      device: { permissions: { ...OK, notifications: false } },
    });
    await runWatchdog(db(), NOW);
    const [job] = await db().select().from(outbox).where(eq(outbox.workspaceId, ws.id));
    expect(job.dedupeKey).toBe(`alert:permission_lost:${device.id}:${NOW.getTime()}:${person.id}`);
  });

  it("stamps low_battery_since / permission_lost_since once per episode, so alerts keep their key, and clears them", async () => {
    const ws = await makeWorkspace(db());
    await makeAdmin(db(), ws.id);
    const d = await makeDevice(db(), ws.id, {
      battery: 10,
      charging: false,
      permissions: { ...OK, notifications: false },
    });
    const fine = await makeDevice(db(), ws.id, { label: "Fine", battery: 80, lowBatterySince: ago(30) });
    const since = async (id: string) => {
      const [r] = await db().select().from(devices).where(eq(devices.id, id));
      return { low: r.lowBatterySince, lost: r.permissionLostSince, updatedAt: r.updatedAt };
    };
    const before = await since(d.id);

    await runWatchdog(db(), NOW);
    expect(await since(d.id)).toEqual({ low: NOW, lost: NOW, updatedAt: before.updatedAt });
    expect((await since(fine.id)).low).toBeNull();

    const later = new Date(NOW.getTime() + 60_000);
    await runWatchdog(db(), later);
    expect(await since(d.id)).toMatchObject({ low: NOW, lost: NOW });
    expect(await db().select().from(outbox).where(eq(outbox.workspaceId, ws.id))).toHaveLength(2);

    await db().update(devices).set({ charging: true, permissions: OK }).where(eq(devices.id, d.id));
    await runWatchdog(db(), new Date(later.getTime() + 60_000));
    expect(await since(d.id)).toMatchObject({ low: null, lost: null });
  });

  it("update_pending alerts admins who opted into update_failed", async () => {
    const ws = await makeWorkspace(db(), { targetUpdateId: "u2" });
    const { person } = await makeAdmin(db(), ws.id);
    const d = await makeDevice(db(), ws.id, {
      configVersion: 4,
      reportedConfigVersion: 4,
      updateId: "u1",
      lastSyncAt: ago(1),
    });
    await db()
      .insert(outbox)
      .values({ workspaceId: ws.id, kind: "push", payload: {}, dedupeKey: `push:${d.id}:4`, createdAt: ago(5) });
    await runWatchdog(db(), NOW);
    const jobs = await db().select().from(outbox).where(eq(outbox.workspaceId, ws.id));
    expect(jobs.map((j) => j.dedupeKey)).toContain(`alert:update_pending:${d.id}:${ago(5).getTime()}:${person.id}`);
  });
});
