/**
 * svc-catalog: driver breaks. ops+ writes. A vehicle on a break stays on its service and keeps tracking, but
 * gives attendees no ETA, doesn't count toward the loop's "how many shuttles", and raises no silent / off-route
 * alert (public/status, alerts/watchdog). One break at a time per vehicle.
 */
import { VehicleBreakEndFields, VehicleBreakFields, withWorkspace } from "@eci-shuttle/shared";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { vehicleBreaks, vehicles } from "@/db/schema";
import type { VehicleBreak } from "@/db/types";
import { type Actor, getInWorkspace, mutate, parseInput, requireRole, ServiceError } from "../kernel";

export const StartBreakInput = withWorkspace(VehicleBreakFields);
export const EndBreakInput = withWorkspace(VehicleBreakEndFields);

/** When the break stops: ended by hand, else its planned end; null = open-ended and still running. */
export const breakEnd = (b: VehicleBreak): Date | null => b.endedAt ?? b.endsAt;

const runningAt = (now: Date) =>
  and(
    lte(vehicleBreaks.startsAt, now),
    isNull(vehicleBreaks.endedAt),
    or(isNull(vehicleBreaks.endsAt), gt(vehicleBreaks.endsAt, now)),
  );

/** No actor (like vehicleStates): callers check access. Vehicle id → its break running at `now`. */
export async function activeBreaks(db: Db, workspaceId: string, now: Date): Promise<Map<string, VehicleBreak>> {
  const rows = await db
    .select()
    .from(vehicleBreaks)
    .where(and(eq(vehicleBreaks.workspaceId, workspaceId), runningAt(now)))
    .orderBy(desc(vehicleBreaks.startsAt));
  const out = new Map<string, VehicleBreak>();
  for (const r of rows) if (!out.has(r.vehicleId)) out.set(r.vehicleId, r);
  return out;
}

async function current(tx: Db, vehicleId: string, now: Date): Promise<VehicleBreak | undefined> {
  const [row] = await tx
    .select()
    .from(vehicleBreaks)
    .where(and(eq(vehicleBreaks.vehicleId, vehicleId), runningAt(now)))
    .orderBy(desc(vehicleBreaks.startsAt))
    .limit(1)
    .for("update");
  return row;
}

/** ops+. A break from `now`, `minutes` long or open-ended. Already on one: its end is replaced. Audited vehicle.break. */
export async function startBreak(
  db: Db,
  actor: Actor,
  input: z.input<typeof StartBreakInput>,
  now: Date,
): Promise<VehicleBreak> {
  const { workspaceId, vehicleId, minutes, note } = parseInput(StartBreakInput, input);
  requireRole(actor, workspaceId, "ops");
  const endsAt = minutes === null ? null : new Date(now.getTime() + minutes * 60_000);
  return mutate(db, actor, { action: "vehicle.break", entity: "vehicle_break", workspaceId }, async (tx) => {
    // lock the vehicle so two taps can't open two breaks
    await getInWorkspace(tx, vehicles, workspaceId, vehicleId, "vehicle", { forUpdate: true });
    const before = await current(tx, vehicleId, now);
    if (before) {
      const [after] = await tx
        .update(vehicleBreaks)
        .set({ endsAt, note: note ?? before.note, version: sql`${vehicleBreaks.version} + 1` })
        .where(eq(vehicleBreaks.id, before.id))
        .returning();
      return { before, after, result: after, entityId: after.id };
    }
    const [row] = await tx
      .insert(vehicleBreaks)
      .values({ workspaceId, vehicleId, startsAt: now, endsAt, note })
      .returning();
    return { before: null, after: row, result: row, entityId: row.id };
  });
}

/** ops+. Ends the vehicle's current break at `now`. NOT_FOUND when it isn't on one. Audited vehicle.break_end. */
export async function endBreak(
  db: Db,
  actor: Actor,
  input: z.input<typeof EndBreakInput>,
  now: Date,
): Promise<VehicleBreak> {
  const { workspaceId, vehicleId } = parseInput(EndBreakInput, input);
  requireRole(actor, workspaceId, "ops");
  return mutate(db, actor, { action: "vehicle.break_end", entity: "vehicle_break", workspaceId }, async (tx) => {
    const v = await getInWorkspace(tx, vehicles, workspaceId, vehicleId, "vehicle", { forUpdate: true });
    const before = await current(tx, vehicleId, now);
    if (!before) throw new ServiceError("NOT_FOUND", `${v.name} isn't on a break.`);
    const [after] = await tx
      .update(vehicleBreaks)
      .set({ endedAt: now, version: sql`${vehicleBreaks.version} + 1` })
      .where(eq(vehicleBreaks.id, before.id))
      .returning();
    return { before, after, result: after, entityId: after.id };
  });
}
