/**
 * svc-subscriptions: attendee alerts from the bot (SPEC §6c For attendees, §3 subscriptions).
 * - arrival_alert: one-shot "message me when the shuttle is N min from <spot>", expires after at most 2 h.
 * - notices: notices for one spot, or all spots (spot_id null).
 * Attendee writes are audited (subscription.*) with the attendee actor. Firing and expiry are bookkeeping by
 * the worker (fired_at / cancelled_at), not audited.
 */
import { and, eq, getTableColumns, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { people, spots, subscriptions } from "@/db/schema";
import type { Person, Subscription } from "@/db/types";
import { type Actor, enqueue, getInWorkspace, mutate, parseInput, readable, ServiceError } from "../kernel";
import { spotAnswer } from "../public/status";

export const ARRIVAL_ALERT_MAX_MS = 2 * 60 * 60_000;
export const DEFAULT_LEAD_MIN = 5;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Only the attendee themselves, in the workspace the bot speaks for. */
function requireAttendee(actor: Actor, workspaceId: string): void {
  if (actor.kind !== "attendee" || (actor.workspaceId && actor.workspaceId !== workspaceId))
    throw new ServiceError("FORBIDDEN", "Not allowed.");
}

/** not fired, not cancelled (expiry is checked separately where it matters) */
const notClosed = and(isNull(subscriptions.firedAt), isNull(subscriptions.cancelledAt)) as SQL;
const openAt = (now: Date) =>
  and(notClosed, or(isNull(subscriptions.expiresAt), gt(subscriptions.expiresAt, now))) as SQL;

export const SubscribeArrivalInput = z.object({
  workspaceId: z.uuid(),
  spotId: z.uuid(),
  /** only this service's shuttles; null = any public service serving the spot */
  serviceId: z.uuid().nullable().default(null),
  leadMin: z.number().int().min(1).max(30).default(DEFAULT_LEAD_MIN),
});

/**
 * Attendee (actor.kind attendee, id = person). The spot must be served by a public service today (INVALID).
 * One open arrival alert per person and spot: a new one replaces it (old gets cancelled_at). expires_at =
 * now + 2 h. Audited subscription.create.
 */
export async function subscribeArrival(
  db: Db,
  actor: Actor,
  input: z.input<typeof SubscribeArrivalInput>,
  now: Date,
): Promise<Subscription> {
  const i = parseInput(SubscribeArrivalInput, input);
  requireAttendee(actor, i.workspaceId);
  const spot = await getInWorkspace(db, spots, i.workspaceId, i.spotId, "spot");
  const lines = spot.archivedAt ? [] : await spotAnswer(db, i.workspaceId, spot.id, now);
  if (lines.length === 0) throw new ServiceError("INVALID", `No shuttle serves ${spot.name} today.`);
  if (i.serviceId && !lines.some((l) => l.serviceId === i.serviceId))
    throw new ServiceError("INVALID", `That shuttle doesn't stop at ${spot.name} today.`);

  return mutate(
    db,
    actor,
    { action: "subscription.create", entity: "subscription", workspaceId: i.workspaceId },
    async (tx) => {
      await tx
        .update(subscriptions)
        .set({ cancelledAt: now })
        .where(
          and(
            eq(subscriptions.personId, actor.id),
            eq(subscriptions.workspaceId, i.workspaceId),
            eq(subscriptions.kind, "arrival_alert"),
            eq(subscriptions.spotId, spot.id),
            notClosed,
          ),
        );
      const [row] = await tx
        .insert(subscriptions)
        .values({
          workspaceId: i.workspaceId,
          personId: actor.id,
          kind: "arrival_alert",
          spotId: spot.id,
          serviceId: i.serviceId,
          leadMin: i.leadMin,
          expiresAt: new Date(now.getTime() + ARRIVAL_ALERT_MAX_MS),
          createdAt: now,
        })
        .returning();
      return { before: null, after: row, result: row };
    },
  );
}

export const SubscribeNoticesInput = z.object({
  workspaceId: z.uuid(),
  /** null = every spot */
  spotId: z.uuid().nullable(),
});

/** Attendee. Idempotent: an existing open subscription for the same spot is returned. Audited subscription.create. */
export async function subscribeNotices(
  db: Db,
  actor: Actor,
  input: z.input<typeof SubscribeNoticesInput>,
  now: Date,
): Promise<Subscription> {
  const i = parseInput(SubscribeNoticesInput, input);
  requireAttendee(actor, i.workspaceId);
  if (i.spotId) await getInWorkspace(db, spots, i.workspaceId, i.spotId, "spot");
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.personId, actor.id),
        eq(subscriptions.workspaceId, i.workspaceId),
        eq(subscriptions.kind, "notices"),
        i.spotId ? eq(subscriptions.spotId, i.spotId) : isNull(subscriptions.spotId),
        notClosed,
      ),
    )
    .limit(1);
  if (existing) return existing;

  return mutate(
    db,
    actor,
    { action: "subscription.create", entity: "subscription", workspaceId: i.workspaceId },
    async (tx) => {
      const [row] = await tx
        .insert(subscriptions)
        .values({ workspaceId: i.workspaceId, personId: actor.id, kind: "notices", spotId: i.spotId, createdAt: now })
        .returning();
      return { before: null, after: row, result: row };
    },
  );
}

/** Attendee: cancel one of their own (another person's → NOT_FOUND), or all when subscriptionId is "all". */
export async function unsubscribe(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; subscriptionId: string | "all" },
  now: Date,
): Promise<number> {
  const { workspaceId, subscriptionId } = input;
  requireAttendee(actor, workspaceId);
  const mine = and(eq(subscriptions.personId, actor.id), eq(subscriptions.workspaceId, workspaceId));

  if (subscriptionId === "all") {
    const open = await db.select().from(subscriptions).where(and(mine, notClosed));
    if (open.length === 0) return 0;
    return mutate(
      db,
      actor,
      { action: "subscription.cancel_all", entity: "subscription", entityId: null, workspaceId },
      async (tx) => {
        const rows = await tx.update(subscriptions).set({ cancelledAt: now }).where(and(mine, notClosed)).returning();
        return { before: { open: rows.length }, after: { open: 0 }, result: rows.length };
      },
    );
  }

  if (!z.uuid().safeParse(subscriptionId).success) throw new ServiceError("NOT_FOUND", "No such subscription.");
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(mine, eq(subscriptions.id, subscriptionId)));
  if (!sub) throw new ServiceError("NOT_FOUND", "No such subscription.", { id: subscriptionId });
  if (sub.firedAt || sub.cancelledAt) return 0;
  return mutate(db, actor, { action: "subscription.cancel", entity: "subscription", workspaceId }, async (tx) => {
    const [after] = await tx
      .update(subscriptions)
      .set({ cancelledAt: now })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return { before: sub, after, result: 1 };
  });
}

/** Attendee: their open subscriptions (not fired, cancelled or expired at now). */
export async function mySubscriptions(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<Subscription[]> {
  requireAttendee(actor, input.workspaceId);
  return db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.personId, actor.id), eq(subscriptions.workspaceId, input.workspaceId), openAt(now)))
    .orderBy(subscriptions.createdAt);
}

/**
 * Fire and expire arrival alerts. Called after ingest with the vehicles that moved, and by the 15 s
 * arrival-alerts job with no filter (all workspaces). For each open arrival_alert: when public/status.spotAnswer
 * has a live line (of its service, if set) with minutes ≤ lead_min → enqueue a Telegram message ("The shuttle is
 * 5 min from Riva", kind arrival, dedupeKey `arrival:<subscriptionId>`) and set fired_at in the same
 * transaction. Past expires_at → enqueue "No shuttle came close in 2 h, alert ended" and set cancelled_at.
 * Never tells attendees about lateness.
 */
export async function runArrivalAlerts(
  db: Db,
  input: { workspaceId?: string; vehicleIds?: string[] },
  now: Date,
): Promise<{ fired: number; expired: number }> {
  // ponytail: vehicleIds is not used to narrow the set; every open alert is checked (correct, just more work).
  // Upgrade if open alerts × spots ever makes this slow.
  const open = await db
    .select({ sub: subscriptions, person: people, spotName: spots.name })
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.personId))
    .innerJoin(spots, eq(spots.id, subscriptions.spotId))
    .where(
      and(
        eq(subscriptions.kind, "arrival_alert"),
        notClosed,
        input.workspaceId ? eq(subscriptions.workspaceId, input.workspaceId) : undefined,
      ),
    );

  let fired = 0;
  let expired = 0;
  const answers = new Map<string, ReturnType<typeof spotAnswer>>();

  for (const { sub, person, spotName } of open) {
    // only the run that closes the row sends: concurrent runs are safe
    const close = (set: Partial<Subscription>, html: string, dedupeKey: string) =>
      db.transaction(async (tx) => {
        const rows = await tx
          .update(subscriptions)
          .set(set)
          .where(and(eq(subscriptions.id, sub.id), notClosed))
          .returning({ id: subscriptions.id });
        if (rows.length === 0) return false;
        await enqueue(tx, {
          kind: "telegram",
          payload: { chatId: person.telegramId, html, kind: "arrival", personId: person.id },
          workspaceId: sub.workspaceId,
          dedupeKey,
        });
        return true;
      });

    if (sub.expiresAt && sub.expiresAt <= now) {
      const html = `No shuttle came within ${sub.leadMin} min of ${esc(spotName)} in 2 h, so your alert ended. Ask again any time with /shuttle.`;
      if (await close({ cancelledAt: now }, html, `arrival-end:${sub.id}`)) expired++;
      continue;
    }

    const key = `${sub.workspaceId}:${sub.spotId}`;
    if (!answers.has(key)) answers.set(key, spotAnswer(db, sub.workspaceId, sub.spotId as string, now));
    const hit = (await answers.get(key))
      ?.filter(
        (l) =>
          l.kind === "live" &&
          l.minutes != null &&
          l.minutes <= (sub.leadMin ?? DEFAULT_LEAD_MIN) &&
          (!sub.serviceId || l.serviceId === sub.serviceId),
      )
      .sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0))[0];
    if (!hit || hit.minutes == null) continue;

    const who = `🚐 The ${esc(hit.serviceName)} shuttle`;
    const html =
      hit.minutes === 0
        ? `${who} is at <b>${esc(spotName)}</b> now — hop on!`
        : `${who} is ${hit.approx ? "about " : ""}<b>${hit.minutes} min</b> from <b>${esc(spotName)}</b>. Time to wander over.`;
    if (await close({ firedAt: now }, html, `arrival:${sub.id}`)) fired++;
  }
  return { fired, expired };
}

/**
 * Who gets a notice by Telegram (the notices job): people with an open `notices` subscription for any of
 * spotIds, or for all spots; "all" (an `everywhere` notice) = every notices subscriber. Blocked-bot people are
 * left out. Distinct people.
 */
export async function noticeRecipients(db: Db, workspaceId: string, spotIds: string[] | "all"): Promise<Person[]> {
  const spotMatch =
    spotIds === "all"
      ? undefined
      : spotIds.length
        ? or(isNull(subscriptions.spotId), inArray(subscriptions.spotId, spotIds))
        : isNull(subscriptions.spotId);
  return db
    .selectDistinct(getTableColumns(people))
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.personId))
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        eq(subscriptions.kind, "notices"),
        notClosed,
        isNull(people.blockedBotAt),
        spotMatch,
      ),
    );
}

/** viewer+. People page: open subscriptions per spot (spotId null = all-spot notice subscribers). */
export async function subscriberCounts(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<{ spotId: string | null; notices: number; arrivalAlerts: number }[]> {
  readable(actor, input.workspaceId);
  return db
    .select({
      spotId: subscriptions.spotId,
      notices: sql<number>`(count(*) filter (where ${subscriptions.kind} = 'notices'))::int`,
      arrivalAlerts: sql<number>`(count(*) filter (where ${subscriptions.kind} = 'arrival_alert'))::int`,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, input.workspaceId), openAt(now)))
    .groupBy(subscriptions.spotId);
}
