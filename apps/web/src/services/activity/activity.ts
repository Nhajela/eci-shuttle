/**
 * svc-activity: reads of the one audit_log (SPEC §7 Activity, §7a). Admin Activity page, each object's timeline
 * and MCP shuttle_activity all read through here. Never writes.
 */
import { notImplemented } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { AuditRow } from "@/db/types";
import type { Actor } from "../kernel";

export const ActivityQuery = z.object({
  workspaceId: z.uuid(),
  /** "spot", "device", "notice", … (audit_log.entity) */
  entity: z.string().min(1).optional(),
  /** with entity: one object's timeline */
  entityId: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  /** every row one MCP confirm wrote */
  proposalId: z.string().min(1).optional(),
  /** only rows at or after this time */
  since: z.iso.datetime({ offset: true }).optional(),
  /** cursor: only rows with id < before (pass the previous page's nextBefore) */
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export type ActivityPage = {
  /** newest first */
  rows: AuditRow[];
  /** cursor for the next (older) page; null when this was the last */
  nextBefore: number | null;
};

/** viewer+. Rows of this workspace only (global rows with workspace_id null, e.g. tokens, are never listed). */
export async function listActivity(db: Db, actor: Actor, input: z.input<typeof ActivityQuery>): Promise<ActivityPage> {
  return notImplemented(db, actor, input);
}

/**
 * Pure. One plain-English line for a row, without the time (callers add it in IST), e.g.
 * "Asha (MCP · claude.ai) cancelled the 10:20 departure on 2026-10-12" or "Phone 'Bus 1' resumed tracking".
 * Uses actor_label, channel, client, action and the after/before diff; unknown actions fall back to
 * "<actor> <action> <entity>".
 */
export function describeAudit(row: AuditRow): string {
  return notImplemented(row);
}
