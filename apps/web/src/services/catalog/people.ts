/** svc-catalog: people, memberships, roles, alert prefs (SPEC §3, §6c, §7 People, §7a Roles). */
import { AlertKind, HHMM, IST_OFFSET_MIN, Role } from "@eci-shuttle/shared";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { alertPrefs, memberships, people } from "@/db/schema";
import type { AlertPrefs, Membership, Person } from "@/db/types";
import { type Actor, checkVersion, mutate, parseInput, readable, requireRole, ServiceError } from "../kernel";

export const TelegramUser = z.object({
  telegramId: z.number().int(),
  username: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
});

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return (err?.code ?? err?.cause?.code) === "23505";
};

const personByTelegram = async (db: Db, telegramId: number) =>
  (await db.select().from(people).where(eq(people.telegramId, telegramId)).limit(1))[0] ?? null;

/**
 * Create or refresh a person from a Telegram login or bot message (system call from auth-bot). Clears
 * blocked_bot_at when they message the bot again. Not audited when only names changed; audited person.create.
 */
export async function upsertPersonFromTelegram(
  db: Db,
  actor: Actor,
  input: z.input<typeof TelegramUser> & { startedBot?: boolean },
): Promise<Person> {
  const { telegramId, ...given } = parseInput(TelegramUser, input);
  // undefined = this call didn't say (keep what we have); null = Telegram says there is none
  const names = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) as Partial<Person>;

  let person = await personByTelegram(db, telegramId);
  if (!person) {
    try {
      return await mutate(db, actor, { action: "person.create", entity: "person", workspaceId: null }, async (tx) => {
        const [row] = await tx
          .insert(people)
          .values({ telegramId, ...names })
          .returning();
        return { before: null, after: row, result: row };
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      person = await personByTelegram(db, telegramId); // lost a race with a concurrent first message
      if (!person) throw e;
    }
  }

  const id = person.id;
  if (Object.entries(names).some(([k, v]) => person[k as keyof Person] !== v)) {
    [person] = await db
      .update(people)
      .set({ ...names, updatedAt: new Date() })
      .where(eq(people.id, id))
      .returning();
  }
  if (input.startedBot && person.blockedBotAt) {
    const before = person;
    person = await mutate(
      db,
      actor,
      { action: "person.unblocked_bot", entity: "person", entityId: id, workspaceId: null },
      async (tx) => {
        const [after] = await tx
          .update(people)
          .set({ blockedBotAt: null, updatedAt: new Date() })
          .where(eq(people.id, id))
          .returning();
        return { before, after, result: after };
      },
    );
  }
  return person;
}

/** Mark that Telegram returned 403 for this person (they blocked the bot). System only. */
export async function markBlockedBot(db: Db, actor: Actor, input: { personId: string; at: Date }): Promise<void> {
  if (actor.kind !== "system") throw new ServiceError("FORBIDDEN", "Not allowed.");
  const [before] = await db.select().from(people).where(eq(people.id, input.personId));
  if (!before) throw new ServiceError("NOT_FOUND", "No such person.", { entity: "person", id: input.personId });
  if (before.blockedBotAt) return; // keep the first time they blocked us; every later 403 says the same
  await mutate(
    db,
    actor,
    { action: "person.blocked_bot", entity: "person", entityId: before.id, workspaceId: null },
    async (tx) => {
      const [after] = await tx
        .update(people)
        .set({ blockedBotAt: input.at, updatedAt: new Date() })
        .where(eq(people.id, before.id))
        .returning();
      return { before, after, result: undefined };
    },
  );
}

/** Every membership of a person: how adapters build an admin Actor for a workspace. No actor needed. */
export async function membershipsOf(db: Db, personId: string): Promise<Membership[]> {
  return db.select().from(memberships).where(eq(memberships.personId, personId)).orderBy(asc(memberships.createdAt));
}

export const SetRoleInput = z.object({
  workspaceId: z.uuid(),
  /** by Telegram username (without @) or person id */
  person: z.union([z.object({ personId: z.uuid() }), z.object({ username: z.string().min(1) })]),
  /** null removes the membership */
  role: Role.nullable(),
});

async function resolvePerson(db: Db, ref: z.output<typeof SetRoleInput>["person"]): Promise<Person> {
  const where =
    "personId" in ref
      ? eq(people.id, ref.personId)
      : eq(sql`lower(${people.username})`, ref.username.replace(/^@/, "").toLowerCase());
  // usernames can move between Telegram accounts: the most recently seen holder wins
  const [p] = await db.select().from(people).where(where).orderBy(desc(people.updatedAt)).limit(1);
  if (!p)
    throw new ServiceError(
      "NOT_FOUND",
      "personId" in ref
        ? "No such person."
        : `Nobody called @${ref.username.replace(/^@/, "")} has messaged the bot yet.`,
      { entity: "person" },
    );
  return p;
}

/**
 * Admin only. Adds, changes or removes a membership. Refuses (CONFLICT) to remove or demote the last admin of a
 * workspace. A username nobody has used yet → NOT_FOUND (they must message the bot first). Audited membership.set.
 */
export async function setRole(db: Db, actor: Actor, input: z.input<typeof SetRoleInput>): Promise<Membership | null> {
  const { workspaceId, person: ref, role } = parseInput(SetRoleInput, input);
  requireRole(actor, workspaceId, "admin");
  const person = await resolvePerson(db, ref);

  return db.transaction(async (tx) => {
    // lock the workspace's admins (in id order) so two admins demoting each other can't both succeed
    const admins = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "admin")))
      .orderBy(asc(memberships.id))
      .for("update");
    const [before] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.personId, person.id)))
      .for("update");

    if ((before?.role ?? null) === role) return before ?? null;
    if (before?.role === "admin" && admins.length <= 1)
      throw new ServiceError("CONFLICT", "This is the last admin of the workspace. Make someone else admin first.", {
        workspaceId,
      });

    const meta = { action: "membership.set", entity: "membership", workspaceId };
    return mutate(tx, actor, meta, async (t) => {
      if (!before) {
        const [after] = await t
          .insert(memberships)
          .values({ personId: person.id, workspaceId, role: role as Role })
          .returning();
        return { before: null, after, result: after };
      }
      if (role === null) {
        await t.delete(memberships).where(eq(memberships.id, before.id));
        return { before, after: null, result: null };
      }
      const [after] = await t
        .update(memberships)
        .set({ role, version: sql`${memberships.version} + 1` })
        .where(eq(memberships.id, before.id))
        .returning();
      return { before, after, result: after };
    });
  });
}

/** viewer+. Members of a workspace with their person rows. */
export async function listMembers(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
): Promise<(Membership & { person: Person })[]> {
  readable(actor, input.workspaceId);
  const rows = await db
    .select()
    .from(memberships)
    .innerJoin(people, eq(people.id, memberships.personId))
    .where(eq(memberships.workspaceId, input.workspaceId))
    .orderBy(asc(memberships.createdAt));
  return rows.map((r) => ({ ...r.memberships, person: r.people }));
}

// ------------------------------------------------------------ alert prefs (§6c)

/** What a member gets before they choose: every ops alert except other admins' changes (SPEC calls that optional). */
export const DEFAULT_ALERT_KINDS: AlertKind[] = AlertKind.options.filter((k) => k !== "admin_changes");

/** A prefs row, or the defaults (id null, version 0) when the member never set any. */
export type AlertPrefsView = Pick<
  AlertPrefs,
  "personId" | "workspaceId" | "kinds" | "quietFrom" | "quietTo" | "version"
> & {
  id: string | null;
};

/** Alert prefs are always the actor's own, in a workspace they belong to (any role). */
function requireMember(actor: Actor, workspaceId: string): void {
  if (actor.kind !== "admin") throw new ServiceError("FORBIDDEN", "Not allowed.");
  readable(actor, workspaceId);
}

const findPrefs = (db: Db, personId: string, workspaceId: string) =>
  db
    .select()
    .from(alertPrefs)
    .where(and(eq(alertPrefs.personId, personId), eq(alertPrefs.workspaceId, workspaceId)));

/** The actor's own alert prefs in a workspace (defaults when never set). */
export async function getAlertPrefs(db: Db, actor: Actor, input: { workspaceId: string }): Promise<AlertPrefsView> {
  requireMember(actor, input.workspaceId);
  const [row] = await findPrefs(db, actor.id, input.workspaceId);
  return (
    row ?? {
      id: null,
      personId: actor.id,
      workspaceId: input.workspaceId,
      kinds: DEFAULT_ALERT_KINDS,
      quietFrom: null,
      quietTo: null,
      version: 0,
    }
  );
}

export const SetAlertPrefsInput = z
  .object({
    workspaceId: z.uuid(),
    /** the version the caller edited (0 = still on defaults) */
    version: z.number().int().nonnegative().optional(),
    kinds: z.array(AlertKind).transform((ks) => [...new Set(ks)]),
    /** IST "HH:MM"; both or neither; null clears; omitted keeps */
    quietFrom: HHMM.nullable().optional(),
    quietTo: HHMM.nullable().optional(),
  })
  .refine(
    (i) => (i.quietFrom === undefined) === (i.quietTo === undefined) && (i.quietFrom === null) === (i.quietTo === null),
    {
      message: "Set both ends of quiet hours, or neither.",
      path: ["quietTo"],
    },
  );

/** Any member, for themselves. Audited alert_prefs.set. */
export async function setAlertPrefs(
  db: Db,
  actor: Actor,
  input: z.input<typeof SetAlertPrefsInput>,
): Promise<AlertPrefs> {
  const { workspaceId, version, kinds, quietFrom, quietTo } = parseInput(SetAlertPrefsInput, input);
  requireMember(actor, workspaceId);
  const meta = { action: "alert_prefs.set", entity: "alert_prefs", workspaceId };
  // ponytail: two first-ever saves racing hit the unique key and one gets a 500; fine for a settings page
  return mutate(db, actor, meta, async (tx) => {
    const [before] = await findPrefs(tx, actor.id, workspaceId).for("update");
    checkVersion(before ?? { version: 0 }, version, "alert setting");
    const quiet = quietFrom === undefined ? {} : { quietFrom, quietTo };
    if (!before) {
      const [after] = await tx
        .insert(alertPrefs)
        .values({ personId: actor.id, workspaceId, kinds, ...quiet })
        .returning();
      return { before: null, after, result: after };
    }
    const [after] = await tx
      .update(alertPrefs)
      .set({ kinds, ...quiet, version: sql`${alertPrefs.version} + 1`, updatedAt: new Date() })
      .where(eq(alertPrefs.id, before.id))
      .returning();
    return { before, after, result: after };
  });
}

/**
 * Who in a workspace gets an alert of this kind (system read for the watchdog / notifier; no actor). Applies the
 * defaults to members without prefs and skips people who blocked the bot. Callers hold alerts during quiet hours.
 */
export async function alertRecipients(
  db: Db,
  input: { workspaceId: string; kind: AlertKind },
): Promise<{ person: Person; role: Role; quietFrom: string | null; quietTo: string | null }[]> {
  const rows = await db
    .select()
    .from(memberships)
    .innerJoin(people, eq(people.id, memberships.personId))
    .leftJoin(
      alertPrefs,
      and(eq(alertPrefs.personId, memberships.personId), eq(alertPrefs.workspaceId, memberships.workspaceId)),
    )
    .where(and(eq(memberships.workspaceId, input.workspaceId), isNull(people.blockedBotAt)))
    .orderBy(asc(memberships.createdAt));
  return rows
    .filter((r) => (r.alert_prefs?.kinds ?? DEFAULT_ALERT_KINDS).includes(input.kind))
    .map((r) => ({
      person: r.people,
      role: r.memberships.role,
      quietFrom: r.alert_prefs?.quietFrom ?? null,
      quietTo: r.alert_prefs?.quietTo ?? null,
    }));
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Pure: is `now` inside these IST quiet hours? End is exclusive; a window may cross midnight. */
export function inQuietHours(prefs: { quietFrom: string | null; quietTo: string | null }, now: Date): boolean {
  if (!prefs.quietFrom || !prefs.quietTo) return false;
  const m = (((Math.floor(now.getTime() / 60_000) + IST_OFFSET_MIN) % 1440) + 1440) % 1440;
  const from = minutes(prefs.quietFrom);
  const to = minutes(prefs.quietTo);
  return from <= to ? m >= from && m < to : m >= from || m < to;
}
