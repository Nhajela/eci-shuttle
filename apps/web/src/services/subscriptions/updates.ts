/**
 * svc-subscriptions: `/subscribe` — a Telegram update every 15 min with a stop's answer (or every stop's), sent
 * only while a shuttle is running there. One open `updates` subscription per person; /stop or the button ends it.
 * Subscribing is audited (subscription.create); sending is worker bookkeeping (last_sent_at), not audited.
 */
import type { AnswerLine, PublicSpot } from "@eci-shuttle/shared";
import { and, eq, isNull, lte, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { people, spots, subscriptions } from "@/db/schema";
import type { Subscription } from "@/db/types";
import { renderAnswer } from "../bot/attendee";
import { encodeCallback } from "../bot/callbacks";
import { type Actor, enqueue, getInWorkspace, mutate, parseInput, ServiceError } from "../kernel";
import { publicStatus } from "../public/status";

export const UPDATE_EVERY_MS = 15 * 60_000;
/** the worker runs every minute: a few seconds early still counts as due */
const SLACK_MS = 30_000;

const open = and(isNull(subscriptions.firedAt), isNull(subscriptions.cancelledAt)) as SQL;

export const SubscribeUpdatesInput = z.object({
  workspaceId: z.uuid(),
  /** null = every stop */
  spotId: z.uuid().nullable(),
});

/**
 * Attendee. Same stop again → the open one is returned; another stop replaces it. last_sent_at starts at now:
 * the reply to /subscribe already carries the current answer, so the first update comes 15 min later.
 */
export async function subscribeUpdates(
  db: Db,
  actor: Actor,
  input: z.input<typeof SubscribeUpdatesInput>,
  now: Date,
): Promise<Subscription> {
  const i = parseInput(SubscribeUpdatesInput, input);
  if (actor.kind !== "attendee" || (actor.workspaceId && actor.workspaceId !== i.workspaceId))
    throw new ServiceError("FORBIDDEN", "Not allowed.");
  if (i.spotId) await getInWorkspace(db, spots, i.workspaceId, i.spotId, "spot");
  const mine = and(
    eq(subscriptions.personId, actor.id),
    eq(subscriptions.workspaceId, i.workspaceId),
    eq(subscriptions.kind, "updates"),
    open,
  );
  const [existing] = await db.select().from(subscriptions).where(mine).limit(1);
  if (existing && existing.spotId === i.spotId) return existing;
  return mutate(
    db,
    actor,
    { action: "subscription.create", entity: "subscription", workspaceId: i.workspaceId },
    async (tx) => {
      await tx.update(subscriptions).set({ cancelledAt: now }).where(mine);
      const [row] = await tx
        .insert(subscriptions)
        .values({
          workspaceId: i.workspaceId,
          personId: actor.id,
          kind: "updates",
          spotId: i.spotId,
          lastSentAt: now,
          createdAt: now,
        })
        .returning();
      return { before: null, after: row, result: row };
    },
  );
}

/** A line worth an update: a shuttle is out (live, on a break, between departures), not before or after hours. */
const running = (l: AnswerLine) =>
  l.kind === "live" || (l.kind === "timetable" && l.phaseText !== "first shuttle today");

/** Pure. The update text for these stops, or null when no shuttle is running at any of them. */
export function updateText(list: PublicSpot[]): string | null {
  const live = list.filter((s) => s.answers.some(running));
  if (!live.length) return null;
  return live.map((s) => renderAnswer(s.name, s.answers.filter(running))).join("\n\n");
}

/**
 * The updates job (every minute): each open `updates` subscription whose last update is ≥ 15 min old gets the
 * current answer for its stop (or every stop), as a Telegram DM with a "Stop updates" button, when a shuttle is
 * running there. Blocked-bot people are skipped. last_sent_at moves only when something is sent, and only the run
 * that moves it sends (safe to run twice).
 */
export async function runUpdates(db: Db, now: Date, input: { workspaceId?: string } = {}): Promise<{ sent: number }> {
  const due = await db
    .select({ sub: subscriptions, person: people })
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.personId))
    .where(
      and(
        eq(subscriptions.kind, "updates"),
        open,
        isNull(people.blockedBotAt),
        input.workspaceId ? eq(subscriptions.workspaceId, input.workspaceId) : undefined,
        or(
          isNull(subscriptions.lastSentAt),
          lte(subscriptions.lastSentAt, new Date(now.getTime() - UPDATE_EVERY_MS + SLACK_MS)),
        ),
      ),
    );
  const statuses = new Map<string, ReturnType<typeof publicStatus>>();
  let sent = 0;
  for (const { sub, person } of due) {
    if (!statuses.has(sub.workspaceId)) statuses.set(sub.workspaceId, publicStatus(db, sub.workspaceId, now));
    const st = await (statuses.get(sub.workspaceId) as ReturnType<typeof publicStatus>);
    const html = updateText(sub.spotId ? st.spots.filter((s) => s.spotId === sub.spotId) : st.spots);
    if (!html) continue;
    const ok = await db.transaction(async (tx) => {
      const rows = await tx
        .update(subscriptions)
        .set({ lastSentAt: now })
        .where(
          and(
            eq(subscriptions.id, sub.id),
            open,
            sub.lastSentAt ? eq(subscriptions.lastSentAt, sub.lastSentAt) : isNull(subscriptions.lastSentAt),
          ),
        )
        .returning({ id: subscriptions.id });
      if (!rows.length) return false;
      await enqueue(tx, {
        kind: "telegram",
        payload: {
          chatId: person.telegramId,
          html,
          kind: "update",
          personId: person.id,
          buttons: [[{ text: "Stop updates", callbackData: encodeCallback({ action: "nunsub", args: [sub.id] }) }]],
        },
        workspaceId: sub.workspaceId,
        dedupeKey: `update:${sub.id}:${now.getTime()}`,
      });
      return true;
    });
    if (ok) sent++;
  }
  return { sent };
}
