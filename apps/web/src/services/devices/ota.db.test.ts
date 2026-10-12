import { randomUUID } from "node:crypto";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, devices } from "@/db/schema";
import type { Actor } from "../kernel";

// bumpConfigs belongs to the config task; here we only check that OTA asks for the right bump.
vi.mock("./config", () => ({ bumpConfigs: vi.fn(async () => []) }));
const { bumpConfigs } = await import("./config");
const { reportUpdateFailed, rollbackUpdate, rolloutUpdate, setPhoneUpdate } = await import("./ota");

const db = () => testDb();
const now = new Date("2026-10-12T04:30:00Z");

async function makeDevice(workspaceId: string, over: Partial<typeof devices.$inferInsert> = {}) {
  const [d] = await db()
    .insert(devices)
    .values({ workspaceId, label: "Phone", tokenHash: randomUUID(), ...over })
    .returning();
  return d;
}
const audits = (action: string, entityId: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)))
    .orderBy(auditLog.id);
const deviceActor = (d: { id: string; workspaceId: string }): Actor => ({
  kind: "device",
  id: d.id,
  workspaceId: d.workspaceId,
  channel: "device",
  label: "Phone",
});

beforeEach(() => vi.mocked(bumpConfigs).mockClear());

describe("rolloutUpdate", () => {
  it("sets the workspace target, audits it, clears stale failures and bumps every phone", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const follower = await makeDevice(ws.id, { updateFailedAt: now });
    const pinned = await makeDevice(ws.id, { targetUpdateId: "pinned", updateFailedAt: now });

    const w = await rolloutUpdate(db(), actor, { workspaceId: ws.id, updateId: "upd-1" });

    expect(w.targetUpdateId).toBe("upd-1");
    expect(w.version).toBe(ws.version + 1);
    const [row] = await audits("ota.rollout", ws.id);
    expect(row).toMatchObject({ workspaceId: ws.id, entity: "workspace", actorId: actor.id });
    expect(row.before).toMatchObject({ targetUpdateId: null });
    expect(row.after).toMatchObject({ targetUpdateId: "upd-1" });
    const [f] = await db().select().from(devices).where(eq(devices.id, follower.id));
    const [p] = await db().select().from(devices).where(eq(devices.id, pinned.id));
    expect(f.updateFailedAt).toBeNull();
    expect(p.updateFailedAt).not.toBeNull(); // its own override didn't change
    expect(bumpConfigs).toHaveBeenCalledWith(expect.anything(), { workspaceId: ws.id }, "ota.rollout");
  });

  it("null stops targeting", async () => {
    const ws = await makeWorkspace(db(), { targetUpdateId: "upd-1" });
    const { actor } = await makeAdmin(db(), ws.id);
    const w = await rolloutUpdate(db(), actor, { workspaceId: ws.id, updateId: null });
    expect(w.targetUpdateId).toBeNull();
  });

  it("is admin only and workspace scoped", async () => {
    const ws = await makeWorkspace(db());
    const { actor: ops } = await makeAdmin(db(), ws.id, "ops");
    await expect(rolloutUpdate(db(), ops, { workspaceId: ws.id, updateId: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const other = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), other.id);
    await expect(rolloutUpdate(db(), actor, { workspaceId: ws.id, updateId: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(bumpConfigs).not.toHaveBeenCalled();
  });

  it("rejects bad input", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await expect(rolloutUpdate(db(), actor, { workspaceId: ws.id, updateId: "" })).rejects.toMatchObject({
      code: "INVALID",
    });
  });
});

describe("setPhoneUpdate", () => {
  it("sets the per-phone override, audits it and bumps that phone", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const d = await makeDevice(ws.id, { updateFailedAt: now });

    await setPhoneUpdate(db(), actor, { workspaceId: ws.id, deviceId: d.id, updateId: "upd-2" });

    const [after] = await db().select().from(devices).where(eq(devices.id, d.id));
    expect(after).toMatchObject({ targetUpdateId: "upd-2", updateFailedAt: null, version: d.version + 1 });
    const [row] = await audits("phone.update", d.id);
    expect(row.after).toMatchObject({ targetUpdateId: "upd-2" });
    expect(bumpConfigs).toHaveBeenCalledWith(expect.anything(), { deviceIds: [d.id] }, "phone.update");

    await setPhoneUpdate(db(), actor, { workspaceId: ws.id, deviceId: d.id, updateId: null });
    const [cleared] = await db().select().from(devices).where(eq(devices.id, d.id));
    expect(cleared.targetUpdateId).toBeNull();
  });

  it("another workspace's phone is NOT_FOUND", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const d = await makeDevice((await makeWorkspace(db())).id);
    await expect(
      setPhoneUpdate(db(), actor, { workspaceId: ws.id, deviceId: d.id, updateId: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("rollbackUpdate", () => {
  it("sets the target back to the one before the last rollout", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await rolloutUpdate(db(), actor, { workspaceId: ws.id, updateId: "upd-1" });
    await rolloutUpdate(db(), actor, { workspaceId: ws.id, updateId: "upd-1" }); // no-op rollout is skipped
    await rolloutUpdate(db(), actor, { workspaceId: ws.id, updateId: "upd-2" });

    const w = await rollbackUpdate(db(), actor, { workspaceId: ws.id });

    expect(w.targetUpdateId).toBe("upd-1");
    const [row] = await audits("ota.rollback", ws.id);
    expect(row.before).toMatchObject({ targetUpdateId: "upd-2" });
    expect(row.after).toMatchObject({ targetUpdateId: "upd-1" });
    expect(bumpConfigs).toHaveBeenLastCalledWith(expect.anything(), { workspaceId: ws.id }, "ota.rollback");
  });

  it("with no earlier rollout there is nothing to roll back to", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await expect(rollbackUpdate(db(), actor, { workspaceId: ws.id })).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("reportUpdateFailed", () => {
  it("marks the phone failed once, audited with the device as actor", async () => {
    const ws = await makeWorkspace(db());
    const d = await makeDevice(ws.id, { targetUpdateId: "upd-3" });

    await reportUpdateFailed(db(), deviceActor(d), now);
    await reportUpdateFailed(db(), deviceActor(d), new Date(now.getTime() + 15_000)); // next sync, still failed

    const [after] = await db().select().from(devices).where(eq(devices.id, d.id));
    expect(after.updateFailedAt).toEqual(now);
    const rows = await audits("device.update_failed", d.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorKind: "device", actorId: d.id, workspaceId: ws.id });
  });

  it("only the device itself may report", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const d = await makeDevice(ws.id);
    await expect(reportUpdateFailed(db(), { ...actor, id: d.id }, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
