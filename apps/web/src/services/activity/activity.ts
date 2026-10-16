/**
 * svc-activity: reads of the one audit_log (SPEC §7 Activity, §7a). Admin Activity page, each object's timeline
 * and MCP shuttle_activity all read through here. Never writes.
 */
import { formatIst } from "@eci-shuttle/shared";
import { and, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { auditLog } from "@/db/schema";
import type { AuditRow } from "@/db/types";
import { type Actor, parseInput, readable } from "../kernel";

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
  const q = parseInput(ActivityQuery, input);
  readable(actor, q.workspaceId);
  const where: SQL[] = [eq(auditLog.workspaceId, q.workspaceId)];
  if (q.entity) where.push(eq(auditLog.entity, q.entity));
  if (q.entityId) where.push(eq(auditLog.entityId, q.entityId));
  if (q.actorId) where.push(eq(auditLog.actorId, q.actorId));
  if (q.proposalId) where.push(eq(auditLog.proposalId, q.proposalId));
  if (q.since) where.push(gte(auditLog.at, new Date(q.since)));
  if (q.before) where.push(lt(auditLog.id, q.before));
  // id order = write order; one extra row tells us whether an older page exists
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.id))
    .limit(q.limit + 1);
  const more = rows.length > q.limit;
  if (more) rows.pop();
  return {
    rows: rows.map((r) => ({ ...r, before: hide(r.before), after: hide(r.after) })),
    nextBefore: more ? rows[rows.length - 1].id : null,
  };
}

type Diff = Record<string, unknown> | null;

/** Diff keys no reader may see: a live pairing code pairs a phone; push tokens and hashes are credentials. */
const SECRET = new Set(["pushToken", "tokenHash", "code", "token"]);

// ponytail: top-level keys only; nested objects in a diff are not scanned
const hide = (d: Diff): Diff =>
  d && Object.fromEntries(Object.entries(d).map(([k, v]) => [k, SECRET.has(k) ? "[hidden]" : v]));

const CHANNEL: Record<string, string> = { mcp: "MCP", telegram: "Telegram" };

function who(row: AuditRow): string {
  const name = row.actorLabel ?? row.actorId;
  if (row.actorKind === "device") return `Phone '${name}'`;
  const via = CHANNEL[row.channel];
  if (!via) return name;
  return `${name} (${row.client ? `${via} · ${row.client}` : via})`;
}

/** "cancelled the 10:20 departure on 2026-10-12" from a service_exceptions row. */
function exception(e: Diff): string {
  const on = `on ${e?.date}`;
  switch (e?.kind) {
    case "cancel_day":
      return `cancelled every departure ${on}`;
    case "cancel_departure":
      return `cancelled the ${e.departure} departure ${on}`;
    case "add_departure":
      return `added a ${e.departure} departure ${on}`;
    case "shift_minutes":
      return `moved the ${e.departure} departure by ${e.minutes} min ${on}`;
    default:
      return "changed one day of a service";
  }
}

/** " 'Riva'" when the row carries a name; diffs of updates usually don't. */
const named = (row: AuditRow): string => {
  const n = row.after?.name ?? row.before?.name ?? row.after?.label ?? row.after?.title;
  return typeof n === "string" ? ` '${n}'` : "";
};

/** IST for ISO timestamps, "none" for null. */
const show = (v: unknown): string => {
  if (v == null) return "none";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatIst(new Date(v));
  return JSON.stringify(v);
};

const changes = (row: AuditRow): string => {
  const parts = Object.keys(row.after ?? {})
    .filter((k) => k !== "version" && !SECRET.has(k))
    .map((k) => `${k} ${show(row.before?.[k])} → ${show(row.after?.[k])}`);
  return parts.length ? `: ${parts.join(", ")}` : "";
};

/** Actions that aren't a plain create/update/archive of a thing. */
const VERBS: Record<string, (row: AuditRow) => string> = {
  "service.exception": (r) => exception(r.after),
  "service.exception_remove": (r) => `undid: ${exception(r.before)}`,
  "service_vehicle.assign": () => "assigned a vehicle to a service",
  "service_vehicle.unassign": () => "took a vehicle off a service",
  "device.resume": () => "resumed tracking",
  "device.permission_lost": () => "lost location permission",
  "device.pair": () => "was paired",
  "pairing_code.create": () => "made a pairing code",
  "phone.kill": () => "stopped a phone",
  "phone.revoke": () => "revoked a phone",
  "phone.nudge": () => "nudged a phone",
  "phone.silence": () => "silenced alerts for a phone",
  "phone.resume": () => "lifted a phone's pause",
  "phone.force_active": () => "forced a phone active",
  "phone.label": (r) => (named(r) ? `renamed a phone to${named(r)}` : "renamed a phone"),
  "phone.assign": () => "assigned a phone to a vehicle",
  "phone.move_workspace": () => "moved a phone to another workspace",
  "notice.create": (r) => `posted notice${named(r)}`,
  "notice.end": () => "ended a notice",
  "membership.set": (r) => (r.after?.role ? `set a role to ${r.after.role}` : "changed a membership"),
  "session.login": () => "signed in",
  "mcp_token.create": () => "connected an MCP client",
  "mcp_token.revoke": () => "revoked an MCP connection",
  "subscription.create": () => "subscribed to arrival alerts",
  "suggestion.accept": () => "accepted a schedule suggestion",
  "suggestion.dismiss": () => "dismissed a schedule suggestion",
};

/**
 * Pure. One plain-English line for a row, without the time (callers add it in IST), e.g.
 * "Asha (MCP · claude.ai) cancelled the 10:20 departure on 2026-10-12" or "Phone 'Bus 1' resumed tracking".
 * Uses actor_label, channel, client, action and the after/before diff; unknown actions fall back to
 * "<actor> <action> <entity>".
 */
export function describeAudit(row: AuditRow): string {
  const verb = VERBS[row.action];
  if (verb) return `${who(row)} ${verb(row)}`;
  const noun = row.entity.replaceAll("_", " ");
  switch (row.action.slice(row.action.indexOf(".") + 1)) {
    case "create":
      return `${who(row)} added ${noun}${named(row)}`;
    case "update":
      return `${who(row)} changed ${noun}${named(row)}${changes(row)}`;
    case "archive":
      return `${who(row)} archived ${noun}${named(row)}`;
    default:
      return `${who(row)} ${row.action} ${row.entity}`;
  }
}
