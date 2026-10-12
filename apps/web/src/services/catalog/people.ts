/** svc-catalog: people, memberships, roles (SPEC §3, §7 People, §7a Roles). */
import { notImplemented, Role } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { Membership, Person } from "@/db/types";
import type { Actor } from "../kernel";

export const TelegramUser = z.object({
  telegramId: z.number().int(),
  username: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
});

/**
 * Create or refresh a person from a Telegram login or bot message (system call from auth-bot). Clears
 * blocked_bot_at when they message the bot again. Not audited when only names changed; audited person.create.
 */
export async function upsertPersonFromTelegram(
  db: Db,
  actor: Actor,
  input: z.input<typeof TelegramUser> & { startedBot?: boolean },
): Promise<Person> {
  return notImplemented(db, actor, input);
}

/** Mark that Telegram returned 403 for this person (they blocked the bot). System only. */
export async function markBlockedBot(db: Db, actor: Actor, input: { personId: string; at: Date }): Promise<void> {
  return notImplemented(db, actor, input);
}

/** Every membership of a person: how adapters build an admin Actor for a workspace. No actor needed. */
export async function membershipsOf(db: Db, personId: string): Promise<Membership[]> {
  return notImplemented(db, personId);
}

export const SetRoleInput = z.object({
  workspaceId: z.uuid(),
  /** by Telegram username (without @) or person id */
  person: z.union([z.object({ personId: z.uuid() }), z.object({ username: z.string().min(1) })]),
  /** null removes the membership */
  role: Role.nullable(),
});
/**
 * Admin only. Adds, changes or removes a membership. Refuses (CONFLICT) to remove or demote the last admin of a
 * workspace. A username nobody has used yet → NOT_FOUND (they must message the bot first). Audited membership.set.
 */
export async function setRole(db: Db, actor: Actor, input: z.input<typeof SetRoleInput>): Promise<Membership | null> {
  return notImplemented(db, actor, input);
}

/** viewer+. Members of a workspace with their person rows. */
export async function listMembers(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
): Promise<(Membership & { person: Person })[]> {
  return notImplemented(db, actor, input);
}
