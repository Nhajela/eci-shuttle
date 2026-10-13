import { createHash, randomBytes } from "node:crypto";
import type { Ping, SyncRequest, SyncResponse } from "@eci-shuttle/shared";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, devices, outbox } from "@/db/schema";
import type { Trip } from "@/db/types";

// ingest, learning and config are other tasks' services: stubbed at their exported interfaces.
vi.mock("../ingest/ingest", () => ({ ingestPings: vi.fn() }));
vi.mock("../learning/learning", () => ({ onTripClosed: vi.fn() }));
vi.mock("./config", () => ({ desiredConfig: vi.fn() }));

const { ingestPings } = await import("../ingest/ingest");
const { onTripClosed } = await import("../learning/learning");
const { desiredConfig } = await import("./config");
const { authenticateDevice, syncDevice, MAX_FUTURE_MS } = await import("./sync");

const db = () => testDb();
const NOW = new Date("2026-10-15T04:30:00Z"); // 10:00 IST
const CONFIG = { configVersion: 7, killed: false } as unknown as SyncResponse;

async function makeDevice(over: Partial<typeof devices.$inferInsert> = {}) {
  const ws = await makeWorkspace(db());
  const token = randomBytes(32).toString("base64url");
  const [d] = await db()
    .insert(devices)
    .values({
      workspaceId: ws.id,
      label: "Bus 1 phone",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
      ...over,
    })
    .returning();
  const actor = await authenticateDevice(db(), `Bearer ${token}`);
  return { ws, device: d, token, actor };
}

const ping = (recordedAt: number, over: Partial<Ping> = {}): Ping => ({
  recordedAt,
  lat: 15.65,
  lng: 73.71,
  accuracy: 8,
  speed: 5,
  heading: 90,
  battery: 80,
  ...over,
});

const req = (over: Partial<SyncRequest> = {}): SyncRequest => ({
  pings: [],
  battery: 77,
  charging: true,
  permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
  reportedMode: "active",
  appliedConfigVersion: 3,
  appVersion: "1.2.0",
  updateId: "upd-1",
  clock: NOW.getTime(),
  ...over,
});

const deviceRow = async (id: string) => (await db().select().from(devices).where(eq(devices.id, id)))[0];
const audits = (id: string, action: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));

beforeEach(() => {
  vi.mocked(ingestPings).mockReset().mockResolvedValue({ inserted: 0, closedTrips: [], vehicleIds: [] });
  vi.mocked(onTripClosed).mockReset().mockResolvedValue();
  vi.mocked(desiredConfig).mockReset().mockResolvedValue(CONFIG);
});

describe("authenticateDevice", () => {
  it("token → device actor", async () => {
    const { ws, device, actor } = await makeDevice();
    expect(actor).toEqual({
      kind: "device",
      id: device.id,
      workspaceId: ws.id,
      channel: "device",
      label: "Bus 1 phone",
    });
  });

  it("accepts the raw token without the Bearer prefix", async () => {
    const { device, token } = await makeDevice();
    expect((await authenticateDevice(db(), token)).id).toBe(device.id);
  });

  it("unknown, empty or missing token → UNAUTHENTICATED", async () => {
    await makeDevice();
    for (const t of ["Bearer nope", "Bearer ", "", null])
      await expect(authenticateDevice(db(), t)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("a revoked device still authenticates", async () => {
    const { device, actor } = await makeDevice({ revokedAt: NOW });
    expect(actor.id).toBe(device.id);
  });
});

describe("syncDevice", () => {
  it("records reported state, clock skew, last sync; returns desiredConfig", async () => {
    const { device, actor } = await makeDevice();
    const res = await syncDevice(db(), actor, req({ clock: NOW.getTime() + 4200, pushToken: "ExpoPush[x]" }), NOW);
    expect(res).toBe(CONFIG);
    expect(vi.mocked(desiredConfig).mock.calls[0][1]).toBe(device.id);
    expect(vi.mocked(desiredConfig).mock.calls[0][2]).toBe(NOW);
    expect(await deviceRow(device.id)).toMatchObject({
      battery: 77,
      charging: true,
      reportedMode: "active",
      reportedConfigVersion: 3,
      appVersion: "1.2.0",
      updateId: "upd-1",
      pushToken: "ExpoPush[x]",
      clockSkewMs: 4200,
      lastSyncAt: NOW,
      updateFailedAt: null,
    });
  });

  it("routine syncs are not audited", async () => {
    const { device, actor } = await makeDevice();
    await syncDevice(db(), actor, req(), NOW);
    expect(await db().select().from(auditLog).where(eq(auditLog.entityId, device.id))).toHaveLength(0);
  });

  it("pushToken omitted keeps the stored one; updateFailed sets then clears update_failed_at", async () => {
    const { device, actor } = await makeDevice({ pushToken: "keep" });
    await syncDevice(db(), actor, req({ updateFailed: true }), NOW);
    expect(await deviceRow(device.id)).toMatchObject({ pushToken: "keep", updateFailedAt: NOW });
    await syncDevice(db(), actor, req({ updateFailed: true }), new Date(NOW.getTime() + 15_000));
    expect((await deviceRow(device.id)).updateFailedAt).toEqual(NOW); // first failure kept
    await syncDevice(db(), actor, req({ updateFailed: false }), NOW);
    expect((await deviceRow(device.id)).updateFailedAt).toBeNull();
  });

  it("clamps an absurd clock skew to the int column", async () => {
    const { device, actor } = await makeDevice();
    await syncDevice(db(), actor, req({ clock: 0 }), NOW);
    expect((await deviceRow(device.id)).clockSkewMs).toBe(-(2 ** 31 - 1));
  });

  it("passes pings to ingest, dropping far-future ones; trips closed go to learning", async () => {
    const { ws, device, actor } = await makeDevice();
    const trip = { id: "t1" } as Trip;
    vi.mocked(ingestPings).mockResolvedValue({ inserted: 2, closedTrips: [trip], vehicleIds: [] });
    const ok = [ping(NOW.getTime() - 20_000), ping(NOW.getTime() + MAX_FUTURE_MS)];
    await syncDevice(db(), actor, req({ pings: [...ok, ping(NOW.getTime() + MAX_FUTURE_MS + 1)] }), NOW);
    expect(ingestPings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ingestPings).mock.calls[0][1]).toEqual({ workspaceId: ws.id, deviceId: device.id, pings: ok });
    expect(onTripClosed).toHaveBeenCalledWith(expect.anything(), trip, NOW);
  });

  it("is idempotent for a retried batch: same pings go to ingest (which dedupes on recorded_at)", async () => {
    const { actor } = await makeDevice();
    const r = req({ pings: [ping(NOW.getTime() - 1000)] });
    await syncDevice(db(), actor, r, NOW);
    await syncDevice(db(), actor, r, NOW);
    expect(vi.mocked(ingestPings).mock.calls.map((c) => c[1].pings)).toEqual([r.pings, r.pings]);
  });

  it("no pings → ingest not called", async () => {
    const { actor } = await makeDevice();
    await syncDevice(db(), actor, req(), NOW);
    expect(ingestPings).not.toHaveBeenCalled();
  });

  it("killed or revoked phones' pings are dropped, state still recorded", async () => {
    for (const over of [{ killedAt: NOW }, { revokedAt: NOW }]) {
      const { device, actor } = await makeDevice(over);
      await syncDevice(db(), actor, req({ pings: [ping(NOW.getTime() - 1000)], reportedMode: "killed" }), NOW);
      expect(ingestPings).not.toHaveBeenCalled();
      expect((await deviceRow(device.id)).lastSyncAt).toEqual(NOW);
    }
  });

  it("resume on a killed phone clears killed_at, bumps config, audits device.resume as the device; pings then ingested", async () => {
    const { device, actor } = await makeDevice({ killedAt: new Date(NOW.getTime() - 3_600_000) });
    await syncDevice(db(), actor, req({ resume: true, pings: [ping(NOW.getTime() - 1000)] }), NOW);
    const row = await deviceRow(device.id);
    expect(row.killedAt).toBeNull();
    expect(row.configVersion).toBe(device.configVersion + 1);
    const a = await audits(device.id, "device.resume");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorKind: "device", actorId: device.id, channel: "device", entity: "device" });
    expect(a[0].after).toMatchObject({ killedAt: null });
    expect(ingestPings).toHaveBeenCalledTimes(1);
  });

  it("resume raises the kill_resume alert to the workspace's admins", async () => {
    const { ws, device, actor } = await makeDevice({ killedAt: new Date(NOW.getTime() - 3_600_000) });
    const { person } = await makeAdmin(db(), ws.id);
    await syncDevice(db(), actor, req({ resume: true }), NOW);
    const alerts = await db()
      .select()
      .from(outbox)
      .where(and(eq(outbox.workspaceId, ws.id), eq(outbox.kind, "telegram")));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload).toMatchObject({ kind: "alert", personId: person.id });
    expect((alerts[0].payload as { html: string }).html).toContain(`Phone '${device.label}' resumed`);
  });

  it("resume on a phone that isn't killed, or is revoked, does nothing", async () => {
    for (const over of [{}, { killedAt: NOW, revokedAt: NOW }]) {
      const { device, actor } = await makeDevice(over);
      await syncDevice(db(), actor, req({ resume: true }), NOW);
      expect(await audits(device.id, "device.resume")).toHaveLength(0);
    }
  });

  it("a permission newly lost is audited device.permission_lost once", async () => {
    const { device, actor } = await makeDevice();
    const lost = {
      location: "foreground",
      preciseLocation: true,
      notifications: false,
      batteryOptimizationExempt: true,
    } as const;
    await syncDevice(db(), actor, req({ permissions: lost }), NOW);
    await syncDevice(db(), actor, req({ permissions: lost }), NOW);
    const a = await audits(device.id, "device.permission_lost");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorKind: "device", actorId: device.id });
    expect(a[0].after).toMatchObject({ permissions: lost });
    expect((await deviceRow(device.id)).permissions).toEqual(lost);
  });

  it("first report (no stored permissions) and regained permissions are not audited", async () => {
    const { device, actor } = await makeDevice({ permissions: null });
    const weak = {
      location: "denied",
      preciseLocation: false,
      notifications: false,
      batteryOptimizationExempt: false,
    } as const;
    await syncDevice(db(), actor, req({ permissions: weak }), NOW);
    await syncDevice(db(), actor, req(), NOW);
    expect(await audits(device.id, "device.permission_lost")).toHaveLength(0);
  });

  it("rejects a non-device actor or another device's actor", async () => {
    const { actor } = await makeDevice();
    for (const a of [
      { ...actor, kind: "system" as const },
      { ...actor, kind: "admin" as const },
    ])
      await expect(syncDevice(db(), a, req(), NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("invalid input → INVALID, nothing written", async () => {
    const { device, actor } = await makeDevice();
    await expect(syncDevice(db(), actor, { ...req(), battery: 150 }, NOW)).rejects.toMatchObject({ code: "INVALID" });
    expect((await deviceRow(device.id)).lastSyncAt).toBeNull();
  });

  it("a device deleted since auth → UNAUTHENTICATED", async () => {
    const { device, actor } = await makeDevice();
    await db().delete(devices).where(eq(devices.id, device.id));
    await expect(syncDevice(db(), actor, req(), NOW)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
