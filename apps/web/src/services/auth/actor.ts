/**
 * svc-auth: how every adapter (admin pages, bot, MCP) turns a person into the Actor services take (SPEC §7a).
 * Services never read sessions; adapters call these and pass the Actor in.
 */
import type { ActorChannel, Role } from "@eci-shuttle/shared";
import { notImplemented } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import type { Person, Workspace } from "@/db/types";
import type { Actor } from "../kernel";

/**
 * An admin Actor for a person acting in a workspace: role from their membership, label = first name or
 * @username. No membership → FORBIDDEN. channel/client/reason are copied onto the actor.
 */
export async function adminActor(
  db: Db,
  input: { personId: string; workspaceId: string; channel: ActorChannel; client?: string; reason?: string },
): Promise<Actor> {
  return notImplemented(db, input);
}

/** A bot user without a role (subscriptions only), acting in the workspace the bot speaks for. */
export function attendeeActor(person: Person, workspaceId: string): Actor {
  return notImplemented(person, workspaceId);
}

/**
 * The admin workspace switcher: the workspace `slug` names when the person is a member of it, else their live
 * workspace membership, else their first membership (by workspace name). null = no memberships at all
 * (the admin adapter shows "ask an admin to add you").
 */
export async function resolveWorkspace(
  db: Db,
  personId: string,
  slug?: string | null,
): Promise<{ workspace: Workspace; role: Role } | null> {
  return notImplemented(db, personId, slug);
}
