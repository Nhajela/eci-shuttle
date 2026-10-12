/**
 * svc-mcp: change-kind dispatch (SPEC §7a). Each McpChange kind runs through the same service function admin
 * uses, so an AI agent's change and an admin's change are the same code and the same audit rows.
 */
import { type McpChange, type McpChangeKind, notImplemented, type Role } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import type { Actor } from "../kernel";

/** Minimum role per change kind (SPEC §7a Roles; matches each service's own requireRole). */
export const CHANGE_ROLE: Record<McpChangeKind, Role> = {
  "spot.create": "ops",
  "spot.update": "ops",
  "spot.archive": "ops",
  "route.create": "ops",
  "route.update": "ops",
  "service.create": "ops",
  "service.update": "ops",
  "service.exception": "ops",
  "service_vehicle.assign": "ops",
  "service_vehicle.unassign": "ops",
  "vehicle.create": "ops",
  "vehicle.update": "ops",
  "phone.label": "ops",
  "phone.assign": "ops",
  "phone.silence": "ops",
  "phone.force_active": "ops",
  "phone.nudge": "ops",
  "phone.kill": "admin",
  "phone.revoke": "admin",
  "phone.move_workspace": "admin",
  "pairing_code.create": "admin",
  "notice.create": "ops",
  "notice.end": "ops",
  "workspace.create": "admin",
};

/**
 * Pure. The "<entity>:<id>" keys whose versions a change depends on, e.g. spot.update → ["spot:<spotId>"],
 * service.exception / service_vehicle.assign → ["service:<serviceId>"], phone.* → ["device:<deviceId>"].
 * Creates (and pairing_code.create, workspace.create) → [].
 */
export function versionKeys(change: McpChange): string[] {
  return notImplemented(change);
}

/** Current version of each key, read inside `workspaceId`. A missing or foreign object → NOT_FOUND. */
export async function loadVersions(db: Db, workspaceId: string, keys: string[]): Promise<Record<string, number>> {
  return notImplemented(db, workspaceId, keys);
}

/**
 * One plain-English line for the propose summary, naming objects by name and times in IST, e.g.
 * "Cancel the 10:20 departure of Riva ↔ Circle on Mon 12 Oct" or "Kill phone 'Ravi's Redmi' (Bus 1)".
 */
export async function describeChange(db: Db, workspaceId: string, change: McpChange): Promise<string> {
  return notImplemented(db, workspaceId, change);
}

/**
 * Warnings for the whole set at `now`, e.g. "Cancelling this leaves Riva without a shuttle 10:00–10:40",
 * "This phone is in a live vehicle right now", "Notice ends before it starts". Empty when nothing to say.
 */
export async function changeWarnings(db: Db, workspaceId: string, changes: McpChange[], now: Date): Promise<string[]> {
  return notImplemented(db, workspaceId, changes, now);
}

/**
 * Run one change with `actor` (it carries proposalId and reason into the audit row) through its service:
 * spot.* → catalog/spots, route.* → catalog/routes, service.* / service_vehicle.* → catalog/schedule,
 * vehicle.* → catalog/vehicles, phone.* → devices/phones, pairing_code.create → devices/pairing,
 * notice.* → notices, workspace.create → catalog/workspaces. Returns the service's result.
 */
export async function applyChange(
  db: Db,
  actor: Actor,
  workspaceId: string,
  change: McpChange,
  now: Date,
): Promise<unknown> {
  return notImplemented(db, actor, workspaceId, change, now);
}
