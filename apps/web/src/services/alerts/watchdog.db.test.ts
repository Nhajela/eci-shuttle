import { istToEpoch, type SyncResponse, type Window } from "@eci-shuttle/shared";
import { makeAssignedDevice, makeDevice } from "@tests/factories/alerts";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { outbox, pings } from "@/db/schema";
import { refreshPhases } from "@/services/ingest/ingest";
import type { TelegramPayload } from "../kernel";
import { detectProblems, runWatchdog } from "./watchdog";

// Other tasks' modules (config, resolveMode, ingest, bot callbacks) are faked to their documented contracts.
const schedules = new Map<string, Window[]>();
vi.mock("@/services/devices/config", () => ({
  desiredConfig: vi.fn(
    async (_db: unknown, deviceId: string) =>
      ({ killed: false, revoked: false, schedule: schedules.get(deviceId) ?? [] }) as unknown as SyncResponse,
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
vi.mock("@/services/bot/callbacks", () => ({
  encodeCallback: ({ action, args }: { action: string; args: string[] }) => [action, ...args].join(":"),
}));

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
const DAY_START = new Date(istToEpoch("2026-10-12", "00:00"));
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

  it("off_route while on duty, since the phase began", async () => {
    const ws = await makeWorkspace(db());
    const { vehicle, device } = await makeAssignedDevice(db(), ws.id, {
      state: { offRoute: true, phase: "en_route", since: ago(3), lastPingAt: ago(0) },
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

  it("low_battery below 15% and not charging, since the first low ping of this episode", async () => {
    const ws = await makeWorkspace(db());
    const low = await makeDevice(db(), ws.id, { battery: 12, charging: false });
    await makeDevice(db(), ws.id, { label: "Charging", battery: 5, charging: true });
    await makeDevice(db(), ws.id, { label: "Fine", battery: 15, charging: false });
    const noPings = await makeDevice(db(), ws.id, { label: "Asha's phone", battery: 9, charging: null });
    const ping = (min: number, battery: number) => ({
      workspaceId: ws.id,
      deviceId: low.id,
      recordedAt: ago(min),
      lat: 15.6,
      lng: 73.7,
      accuracy: 5,
      battery,
    });
    await db()
      .insert(pings)
      .values([ping(60, 10), ping(40, 30), ping(20, 14), ping(10, 12)]);

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
    expect(problems).toContainEqual(expect.objectContaining({ deviceId: noPings.id, since: DAY_START }));
  });

  it("permission_lost when location isn't 'always' or notifications are off", async () => {
    const ws = await makeWorkspace(db());
    const d = await makeDevice(db(), ws.id, { permissions: { ...OK, location: "foreground", notifications: false } });
    await makeDevice(db(), ws.id, { label: "OK", permissions: OK });
    expect(await detectProblems(db(), ws.id, NOW)).toEqual([
      {
        kind: "permission_lost",
        workspaceId: ws.id,
        vehicleId: null,
        deviceId: d.id,
        since: DAY_START,
        message: "Ravi's phone: location isn't set to 'Allow all the time', notifications are off",
      },
    ]);
  });

  it("mode_mismatch: kill pending, reported ≠ desired after a sync, config behind > 2 min after the push", async () => {
    const ws = await makeWorkspace(db());
    const killed = await makeDevice(db(), ws.id, { label: "K", killedAt: ago(5), reportedMode: "active" });
    await makeDevice(db(), ws.id, { label: "K done", killedAt: ago(5), reportedMode: "killed" });
    await makeDevice(db(), ws.id, { label: "K new", killedAt: ago(1), reportedMode: "active" });
    const wrong = await makeAssignedDevice(db(), ws.id, {
      device: { label: "W", reportedMode: "idle", lastSyncAt: ago(1) },
      state: { lastPingAt: ago(1) },
    });
    schedules.set(wrong.device.id, activeSince(10));
    const notSynced = await makeAssignedDevice(db(), ws.id, {
      vehicle: { name: "Bus 2" },
      device: { label: "N", reportedMode: "idle", lastSyncAt: ago(11) },
      state: { lastPingAt: ago(1) },
    });
    schedules.set(notSynced.device.id, activeSince(10));
    const behind = await makeDevice(db(), ws.id, { label: "B", configVersion: 3, reportedConfigVersion: 2 });
    const behindNew = await makeDevice(db(), ws.id, { label: "B new", configVersion: 3, reportedConfigVersion: 2 });
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
        ["mode_mismatch", wrong.device.id, ago(10)],
        ["mode_mismatch", behind.id, ago(3)],
      ]),
    );
    expect(problems).toHaveLength(3);
    expect(problems.find((p) => p.deviceId === killed.id)?.message).toBe("K was killed but still reports active");
    expect(problems.find((p) => p.deviceId === wrong.device.id)?.message).toBe("W reports idle but should be active");
    expect(problems.find((p) => p.deviceId === behind.id)?.message).toBe("B hasn't picked up its new settings");
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
});
