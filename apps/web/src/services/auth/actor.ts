/**
 * svc-auth: how every adapter (admin pages, bot, MCP) turns a person into the Actor services take (SPEC §7a).
 * Services never read sessions; adapters call these and pass the Actor in.
 */
import type { ActorChannel, Role } from "@eci-shuttle/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { memberships, people, workspaces } from "@/db/schema";
import type { Person, Workspace } from "@/db/types";
import { type Actor, ServiceError } from "../kernel";

const label = (p: Pick<Person, "firstName" | "username">) => p.firstName || (p.username ? `@${p.username}` : undefined);

/**
 * An admin Actor for a person acting in a workspace: role from their membership, label = first name or
 * @username. No membership → FORBIDDEN. channel/client/reason are copied onto the actor.
 */
export async function adminActor(
  db: Db,
  input: { personId: string; workspaceId: string; channel: ActorChannel; client?: string; reason?: string },
): Promise<Actor> {
  const [row] = await db
    .select({ role: memberships.role, firstName: people.firstName, username: people.username })
    .from(memberships)
    .innerJoin(people, eq(people.id, memberships.personId))
    .where(and(eq(memberships.personId, input.personId), eq(memberships.workspaceId, input.workspaceId)));
  if (!row) throw new ServiceError("FORBIDDEN", "You're not a member of this workspace.");
  const actor: Actor = {
    kind: "admin",
    id: input.personId,
    workspaceId: input.workspaceId,
    role: row.role,
    channel: input.channel,
    label: label(row),
  };
  if (input.client) actor.client = input.client;
  if (input.reason) actor.reason = input.reason;
  return actor;
}

/** A bot user without a role (subscriptions only), acting in the workspace the bot speaks for. */
export function attendeeActor(person: Person, workspaceId: string): Actor {
  return { kind: "attendee", id: person.id, workspaceId, channel: "telegram", label: label(person) };
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
  const rows = await db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.personId, personId))
    .orderBy(asc(workspaces.name));
  return (
    (slug && rows.find((r) => r.workspace.slug === slug)) || rows.find((r) => r.workspace.isLive) || rows[0] || null
  );
}
