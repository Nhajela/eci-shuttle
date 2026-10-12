/** svc-devices: server-controlled OTA updates (SPEC §5). admin only, except the phone's own failure report. */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { auditLog, devices, workspaces } from "@/db/schema";
import type { Workspace } from "@/db/types";
import { type Actor, getInWorkspace, mutate, parseInput, requireRole, ServiceError } from "../kernel";
import { bumpConfigs } from "./config";

export const RolloutInput = z.object({ workspaceId: z.uuid(), updateId: z.string().min(1).nullable() });
/** "Roll out update X to all phones in this workspace" (null = stop targeting). Bumps every config. */
export async function rolloutUpdate(db: Db, actor: Actor, input: z.input<typeof RolloutInput>): Promise<Workspace> {
  const { workspaceId, updateId } = parseInput(RolloutInput, input);
  requireRole(actor, workspaceId, "admin");
  return setWorkspaceTarget(db, actor, workspaceId, updateId, "ota.rollout");
}

export const RollbackInput = z.object({ workspaceId: z.uuid() });
/** Target the update that was running before the last rollout again (SPEC §5 "rolling back"). */
export async function rollbackUpdate(db: Db, actor: Actor, input: z.input<typeof RollbackInput>): Promise<Workspace> {
  const { workspaceId } = parseInput(RollbackInput, input);
  requireRole(actor, workspaceId, "admin");
  // the audit diff's `before` holds targetUpdateId only when that rollout changed it
  const [last] = await db
    .select({ before: auditLog.before })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "ota.rollout"),
        eq(auditLog.entityId, workspaceId),
        sql`${auditLog.before} -> 'targetUpdateId' IS NOT NULL`,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(1);
  if (!last) throw new ServiceError("INVALID", "There's no earlier update to roll back to.");
  const previous = (last.before as { targetUpdateId: string | null }).targetUpdateId;
  return setWorkspaceTarget(db, actor, workspaceId, previous, "ota.rollback");
}

async function setWorkspaceTarget(
  db: Db,
  actor: Actor,
  workspaceId: string,
  updateId: string | null,
  action: "ota.rollout" | "ota.rollback",
): Promise<Workspace> {
  return mutate(db, actor, { action, entity: "workspace", entityId: workspaceId, workspaceId }, async (tx) => {
    const [before] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    if (!before) throw new ServiceError("NOT_FOUND", "No such workspace.", { entity: "workspace", id: workspaceId });
    const [after] = await tx
      .update(workspaces)
      .set({ targetUpdateId: updateId, version: sql`${workspaces.version} + 1`, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning();
    // a failure flag belongs to the old target; phones following the workspace get a fresh try
    await tx
      .update(devices)
      .set({ updateFailedAt: null })
      .where(and(eq(devices.workspaceId, workspaceId), isNull(devices.targetUpdateId)));
    await bumpConfigs(tx, { workspaceId }, action);
    return { before, after, result: after };
  });
}

export const PhoneUpdateInput = z.object({
  workspaceId: z.uuid(),
  deviceId: z.uuid(),
  updateId: z.string().min(1).nullable(),
});
/** Per-phone "update now" (override, null = follow the workspace). Bumps the config and pushes. */
export async function setPhoneUpdate(db: Db, actor: Actor, input: z.input<typeof PhoneUpdateInput>): Promise<void> {
  const { workspaceId, deviceId, updateId } = parseInput(PhoneUpdateInput, input);
  requireRole(actor, workspaceId, "admin");
  await mutate(db, actor, { action: "phone.update", entity: "device", entityId: deviceId, workspaceId }, async (tx) => {
    const before = await getInWorkspace(tx, devices, workspaceId, deviceId, "phone", { forUpdate: true });
    const [after] = await tx
      .update(devices)
      .set({
        targetUpdateId: updateId,
        updateFailedAt: null,
        version: sql`${devices.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(devices.id, deviceId))
      .returning();
    await bumpConfigs(tx, { deviceIds: [deviceId] }, "phone.update");
    return { before, after, result: undefined };
  });
}

/**
 * The phone says its OTA crashed and expo-updates fell back (sync's updateFailed). Sets update_failed_at once
 * (admin shows "update failed"); repeat reports while it is still set are no-ops, so syncs don't spam the audit.
 */
export async function reportUpdateFailed(db: Db, actor: Actor, now: Date): Promise<void> {
  if (actor.kind !== "device" || !actor.workspaceId) throw new ServiceError("FORBIDDEN", "Not allowed.");
  const workspaceId = actor.workspaceId;
  const [current] = await db.select({ failedAt: devices.updateFailedAt }).from(devices).where(eq(devices.id, actor.id));
  if (!current || current.failedAt) return;
  await mutate(
    db,
    actor,
    { action: "device.update_failed", entity: "device", entityId: actor.id, workspaceId },
    async (tx) => {
      const before = await getInWorkspace(tx, devices, workspaceId, actor.id, "phone", { forUpdate: true });
      const [after] = await tx.update(devices).set({ updateFailedAt: now }).where(eq(devices.id, actor.id)).returning();
      return { before, after, result: undefined };
    },
  );
}
