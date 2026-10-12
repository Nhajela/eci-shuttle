import { createHash } from "node:crypto";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { auditLog, devices, pairingCodes } from "@/db/schema";
import { systemActor } from "../kernel";
import { createPairingCode, MAX_FAILED_PAIRS, PAIRING_CODE_TTL_MS, pairDevice } from "./pairing";

// desiredConfig belongs to svc-config; pairing only passes its answer through.
vi.mock("./config", () => ({
  desiredConfig: vi.fn(async (_db: unknown, deviceId: string) => ({ configVersion: 1, deviceId })),
}));

const db = () => testDb();
const NOW = new Date("2026-10-12T04:30:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const pairReq = (code: string, over = {}) => ({
  code,
  model: "Pixel 7",
  appVersion: "1.0.0",
  updateId: null,
  pushToken: "ExponentPushToken[x]",
  ...over,
});

describe("createPairingCode", () => {
  it("makes a 6-digit code valid 10 min, with a QR link on PUBLIC_ORIGIN, audited", async () => {
    const ws = await makeWorkspace(db());
    const { actor, person } = await makeAdmin(db(), ws.id);
    const r = await createPairingCode(db(), actor, { workspaceId: ws.id, label: "Bus 1 phone" }, NOW);
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.qrUrl).toBe(`${process.env.PUBLIC_ORIGIN}/pair/${r.code}`);
    expect(r.expiresAt).toEqual(later(PAIRING_CODE_TTL_MS));
    expect(PAIRING_CODE_TTL_MS).toBe(10 * 60_000);
    const [row] = await db().select().from(pairingCodes).where(eq(pairingCodes.code, r.code));
    expect(row).toMatchObject({ workspaceId: ws.id, label: "Bus 1 phone", createdByPersonId: person.id, usedAt: null });
    const audit = await db().select().from(auditLog).where(eq(auditLog.entityId, r.code));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "pairing_code.create", entity: "pairing_code", workspaceId: ws.id });
  });

  it("refuses ops and other workspaces' admins", async () => {
    const ws = await makeWorkspace(db());
    const other = await makeWorkspace(db());
    const { actor: ops } = await makeAdmin(db(), ws.id, "ops");
    const { actor: stranger } = await makeAdmin(db(), other.id);
    await expect(createPairingCode(db(), ops, { workspaceId: ws.id }, NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(createPairingCode(db(), stranger, { workspaceId: ws.id }, NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("pairDevice", () => {
  it("swaps a fresh code for a device with a hashed token, marks the code used, audits as the device", async () => {
    const ws = await makeWorkspace(db());
    const c = await createPairingCode(db(), systemActor("test"), { workspaceId: ws.id, label: "Bus 2" }, NOW);
    const r = await pairDevice(db(), pairReq(c.code), later(60_000));
    expect(r.token.length).toBeGreaterThanOrEqual(43);
    expect(r.config).toMatchObject({ deviceId: r.deviceId });

    const [d] = await db().select().from(devices).where(eq(devices.id, r.deviceId));
    expect(d).toMatchObject({
      workspaceId: ws.id,
      label: "Bus 2",
      tokenHash: sha256(r.token),
      model: "Pixel 7",
      appVersion: "1.0.0",
      pushToken: "ExponentPushToken[x]",
    });
    const [code] = await db().select().from(pairingCodes).where(eq(pairingCodes.code, c.code));
    expect(code).toMatchObject({ usedAt: later(60_000), deviceId: r.deviceId });

    const audit = await db().select().from(auditLog).where(eq(auditLog.entityId, r.deviceId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "device.pair",
      actorKind: "device",
      actorId: r.deviceId,
      channel: "device",
    });
    expect(JSON.stringify(audit[0].after)).not.toContain(d.tokenHash);
  });

  it("labels the device with the model when the code has no label", async () => {
    const ws = await makeWorkspace(db());
    const c = await createPairingCode(db(), systemActor("test"), { workspaceId: ws.id }, NOW);
    const r = await pairDevice(db(), pairReq(c.code, { model: "Redmi Note 12" }), NOW);
    const [d] = await db().select().from(devices).where(eq(devices.id, r.deviceId));
    expect(d.label).toBe("Redmi Note 12");
  });

  it("unknown, used and expired fail identically (a probe learns nothing); each miss is audited", async () => {
    const ws = await makeWorkspace(db());
    const used = await createPairingCode(db(), systemActor("test"), { workspaceId: ws.id }, NOW);
    await pairDevice(db(), pairReq(used.code), NOW);
    const old = await createPairingCode(db(), systemActor("test"), { workspaceId: ws.id }, NOW);
    const fail = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e) => ({ code: e.code, message: e.message }),
      );
    const fails = [
      await fail(pairDevice(db(), pairReq(used.code), NOW)),
      await fail(pairDevice(db(), pairReq(old.code), later(PAIRING_CODE_TTL_MS))),
      // never generated: codes are digits only
      await fail(pairDevice(db(), pairReq("nope42"), NOW)),
    ];
    expect(fails[0]?.code).toBe("NOT_FOUND");
    expect(fails[1]).toEqual(fails[0]);
    expect(fails[2]).toEqual(fails[0]);
    const misses = await db().select().from(auditLog).where(eq(auditLog.action, "device.pair_failed"));
    expect(misses.map((m) => m.entityId)).toEqual(expect.arrayContaining([used.code, old.code, "nope42"]));
    expect(misses[0]).toMatchObject({ workspaceId: null, actorKind: "device", channel: "device" });
  });

  it("two phones racing for one code: exactly one pairs", async () => {
    const ws = await makeWorkspace(db());
    const c = await createPairingCode(db(), systemActor("test"), { workspaceId: ws.id }, NOW);
    const results = await Promise.allSettled([
      pairDevice(db(), pairReq(c.code), NOW),
      pairDevice(db(), pairReq(c.code), NOW),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "NOT_FOUND" } });
    expect(await db().select().from(devices).where(eq(devices.workspaceId, ws.id))).toHaveLength(1);
  });

  // last: its misses count against every later pair in this worker's DB
  it(`after ${MAX_FAILED_PAIRS} misses in 10 min, refuses every pair (even a good code) with RATE_LIMITED`, async () => {
    const ws = await makeWorkspace(db());
    const good = await createPairingCode(db(), systemActor("test"), { workspaceId: ws.id }, NOW);
    for (let i = 0; i < MAX_FAILED_PAIRS; i++) await pairDevice(db(), pairReq("000000"), NOW).catch(() => {});
    await expect(pairDevice(db(), pairReq(good.code), NOW)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(pairDevice(db(), pairReq("000000"), NOW)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
