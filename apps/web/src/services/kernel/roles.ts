import { ROLE_RANK, type Role } from "@eci-shuttle/shared";
import type { Actor } from "./actor";
import { ServiceError } from "./errors";

/**
 * The only role check (SPEC §7a): admin can do everything; ops schedule, notices, silence, force active,
 * nudge, spots; viewer reads. Kill, revoke, move workspace and role changes need admin.
 * System actors pass. Devices never hold roles (use requireDevice).
 * An admin acting in a workspace other than actor.workspaceId is refused: adapters build the actor for the
 * workspace being acted on (services needing two workspaces look the second membership up themselves).
 */
export function requireRole(actor: Actor, workspaceId: string, minRole: Role): void {
  if (actor.kind === "system") return;
  if (actor.kind !== "admin") throw new ServiceError("FORBIDDEN", "Not allowed.");
  if (actor.workspaceId !== workspaceId || !actor.role)
    throw new ServiceError("FORBIDDEN", "You're not a member of this workspace.", { workspaceId });
  if (ROLE_RANK[actor.role] < ROLE_RANK[minRole])
    throw new ServiceError("FORBIDDEN", `This needs the ${minRole} role.`, { role: actor.role, needs: minRole });
}

export function can(actor: Actor, workspaceId: string, minRole: Role): boolean {
  try {
    requireRole(actor, workspaceId, minRole);
    return true;
  } catch {
    return false;
  }
}

/** A device may only act on itself. */
export function requireDevice(actor: Actor, deviceId: string): void {
  if (actor.kind !== "device" || actor.id !== deviceId) throw new ServiceError("FORBIDDEN", "Not allowed.");
}
