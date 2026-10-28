/**
 * svc-subscriptions: `/need` — "I'm at Riva and need a shuttle to Circle". A `pickup` subscription (spot_id = from,
 * to_spot_id = to), one open per person, for at most 60 min, only while a public service runs now. Ops get a
 * `pickup_request` alert and see it on the Live board and in MCP shuttle_status. When a shuttle is at the pickup
 * spot (the public answer says "here now"), the person gets "The shuttle is here at Riva" and the request closes.
 * Requesting is audited (subscription.create); cancelling goes through subscriptions.unsubscribe (/stop, the
 * button); firing and expiry are worker bookkeeping (fired_at / cancelled_at), not audited.
 * Never mentions lateness.
 */
import { and, asc, eq, gt, isNull, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db } from "@/db";
import { people, services, spots, subscriptions, vehicleState, vehicles } from "@/db/schema";
import type { Subscription } from "@/db/types";
import { escapeHtml } from "@/lib/telegram/html";
import { adminButton, raiseAlert } from "../alerts/alerts";
import { activeBreaks, breakEnd } from "../catalog/breaks";
import { type Actor, enqueue, getInWorkspace, mutate, parseInput, readable, ServiceError } from "../kernel";
import { isPredictedLine } from "../public/sight";
import { publicStatus, spotAnswer } from "../public/status";
import {
  type AlertVehicle,
  groupWaiting,
  needSpots,
  notRunningText,
  requesterName,
  type WaitingSpot,
  waitingAlertText,
} from "./need-text";

export const PICKUP_MAX_MS = 60 * 60_000;
/** ops are alerted when the requests waiting at a stop reach a multiple of this (3, 6, 9 …) */
export const PICKUP_ALERT_EVERY = 3;
/** "on the way" when a live ETA to the pickup is at most this, or a shuttle's next stop is the pickup */
export const ON_THE_WAY_MIN = 10;
const esc = escapeHtml;

const notClosed = and(isNull(subscriptions.firedAt), isNull(subscriptions.cancelledAt)) as SQL;
const openAt = (now: Date) => and(notClosed, gt(subscriptions.expiresAt, now)) as SQL;
const toSpots = alias(spots, "to_spots");
/** a vehicle counts as heading somewhere while its last ping is this fresh (as on the public page) */
const FRESH_MS = 2 * 60_000;

export const RequestPickupInput = z.object({
  workspaceId: z.uuid(),
  fromSpotId: z.uuid(),
  toSpotId: z.uuid(),
});

/**
 * Attendee. Both stops must be served by a public service running now (INVALID with a plain reason). Replaces the
 * person's open request (cancelled_at). expires_at = now + 60 min. In the same transaction, when the requests
 * waiting at that stop reach 3, 6, 9 …: a `pickup_request` alert to the workspace's members whose prefs include it
 * (waitingAlertText). Audited subscription.create.
 */
export async function requestPickup(
  db: Db,
  actor: Actor,
  input: z.input<typeof RequestPickupInput>,
  now: Date,
): Promise<{ request: Subscription; replaced: boolean }> {
  const i = parseInput(RequestPickupInput, input);
  if (actor.kind !== "attendee" || (actor.workspaceId && actor.workspaceId !== i.workspaceId))
    throw new ServiceError("FORBIDDEN", "Not allowed.");
  if (i.fromSpotId === i.toSpotId) throw new ServiceError("INVALID", "Pick a different stop to go to.");
  const from = await getInWorkspace(db, spots, i.workspaceId, i.fromSpotId, "spot");
  const to = await getInWorkspace(db, spots, i.workspaceId, i.toSpotId, "spot");
  const live = needSpots(await publicStatus(db, i.workspaceId, now));
  if (!live.spots.length) throw new ServiceError("INVALID", notRunningText(live.nextStart));
  for (const s of [from, to])
    if (!live.spots.some((x) => x.spotId === s.id))
      throw new ServiceError("INVALID", `No shuttle stops at ${s.shortName} right now.`);
  const [person] = await db.select().from(people).where(eq(people.id, actor.id));
  if (!person) throw new ServiceError("NOT_FOUND", "Unknown person.");

  return mutate(
    db,
    actor,
    { action: "subscription.create", entity: "subscription", workspaceId: i.workspaceId },
    async (tx) => {
      const waitingAtFrom = and(
        eq(subscriptions.workspaceId, i.workspaceId),
        eq(subscriptions.kind, "pickup"),
        eq(subscriptions.spotId, from.id),
        openAt(now),
      );
      const [{ n: before }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(subscriptions)
        .where(waitingAtFrom);
      const old = await tx
        .update(subscriptions)
        .set({ cancelledAt: now })
        .where(
          and(
            eq(subscriptions.personId, actor.id),
            eq(subscriptions.workspaceId, i.workspaceId),
            eq(subscriptions.kind, "pickup"),
            notClosed,
          ),
        )
        .returning({ id: subscriptions.id });
      const [row] = await tx
        .insert(subscriptions)
        .values({
          workspaceId: i.workspaceId,
          personId: actor.id,
          kind: "pickup",
          spotId: from.id,
          toSpotId: to.id,
          expiresAt: new Date(now.getTime() + PICKUP_MAX_MS),
          createdAt: now,
        })
        .returning();
      const waiting = await tx
        .select({ sub: subscriptions, person: people, to: toSpots.shortName })
        .from(subscriptions)
        .innerJoin(people, eq(people.id, subscriptions.personId))
        .innerJoin(toSpots, eq(toSpots.id, subscriptions.toSpotId))
        .where(waitingAtFrom)
        .orderBy(asc(subscriptions.createdAt));
      // only when the count went up (a replaced request at the same stop doesn't re-alert); the request that made
      // it reach the multiple is in the key, so falling back below and climbing again alerts again
      if (waiting.length > before && waiting.length % PICKUP_ALERT_EVERY === 0)
        await raiseAlert(
          tx,
          {
            workspaceId: i.workspaceId,
            kind: "pickup_request",
            key: `need:${from.id}:${waiting.length}:${row.id}`,
            html: waitingAlertText({
              spotName: from.shortName,
              waiting: waiting.map((w) => ({ name: requesterName(w.person), to: w.to })),
              since: waiting[0]?.sub.createdAt ?? now,
              vehicles: await alertVehicles(tx, i.workspaceId, now),
            }),
            buttons: [[await adminButton(tx, i.workspaceId, "live")]],
          },
          now,
        );
      return { before: null, after: row, result: { request: row, replaced: old.length > 0 } };
    },
  );
}

/**
 * The person's open request (not fired, cancelled or expired), with its stops' short names, or null.
 * Attendee only.
 */
export async function myPickup(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<{ request: Subscription; from: string; to: string } | null> {
  if (actor.kind !== "attendee") throw new ServiceError("FORBIDDEN", "Not allowed.");
  const [r] = await db
    .select({ request: subscriptions, from: spots.shortName, to: toSpots.shortName })
    .from(subscriptions)
    .innerJoin(spots, eq(spots.id, subscriptions.spotId))
    .innerJoin(toSpots, eq(toSpots.id, subscriptions.toSpotId))
    .where(
      and(
        eq(subscriptions.personId, actor.id),
        eq(subscriptions.workspaceId, input.workspaceId),
        eq(subscriptions.kind, "pickup"),
        openAt(now),
      ),
    )
    .limit(1);
  return r ?? null;
}

/**
 * The worker (arrival-alerts job, every 15 s): each open pickup request
 * - past expires_at → DM "Your request … has expired after 60 min" and set cancelled_at;
 * - a shuttle is at its pickup spot now (public/status.spotAnswer: a live line with minutes 0) → DM "The shuttle
 *   is here at Riva." and set fired_at (closed);
 * - else, once per request (last_sent_at marks it): a live ETA ≤ 10 min, or a fresh en-route vehicle on a public
 *   service whose next stop is the pickup → DM "The shuttle is on its way to Riva, about 6 min.".
 * Only the run that moves the row sends (safe to run twice). Never mentions lateness.
 */
export async function runPickups(
  db: Db,
  input: { workspaceId?: string },
  now: Date,
): Promise<{ fired: number; onTheWay: number; expired: number }> {
  const open = await db
    .select({ sub: subscriptions, person: people, from: spots.shortName, to: toSpots.shortName })
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.personId))
    .innerJoin(spots, eq(spots.id, subscriptions.spotId))
    .innerJoin(toSpots, eq(toSpots.id, subscriptions.toSpotId))
    .where(
      and(
        eq(subscriptions.kind, "pickup"),
        notClosed,
        input.workspaceId ? eq(subscriptions.workspaceId, input.workspaceId) : undefined,
      ),
    );
  const out = { fired: 0, onTheWay: 0, expired: 0 };
  const answers = new Map<string, ReturnType<typeof spotAnswer>>();
  const heading = new Map<string, Promise<Set<string>>>();

  for (const { sub, person, from, to } of open) {
    /** move the row (only if still as read), and queue the DM in the same transaction */
    const send = (set: Partial<Subscription>, html: string, dedupeKey: string) =>
      db.transaction(async (tx) => {
        const rows = await tx
          .update(subscriptions)
          .set(set)
          .where(
            and(
              eq(subscriptions.id, sub.id),
              notClosed,
              "lastSentAt" in set ? isNull(subscriptions.lastSentAt) : undefined,
            ),
          )
          .returning({ id: subscriptions.id });
        if (!rows.length) return false;
        await enqueue(tx, {
          kind: "telegram",
          payload: { chatId: person.telegramId, html, kind: "arrival", personId: person.id },
          workspaceId: sub.workspaceId,
          dedupeKey,
        });
        return true;
      });

    if (!sub.expiresAt || sub.expiresAt <= now) {
      const html = `⏳ Your request for a shuttle from ${esc(from)} to ${esc(to)} has expired after 60 min. Send /need if you still need one.`;
      if (await send({ cancelledAt: now }, html, `need-end:${sub.id}`)) out.expired++;
      continue;
    }
    const spotId = sub.spotId as string;
    const key = `${sub.workspaceId}:${spotId}`;
    if (!answers.has(key)) answers.set(key, spotAnswer(db, sub.workspaceId, spotId, now));
    const live = ((await answers.get(key)) ?? [])
      // an estimate through a no-signal stretch never says "here" or "on its way" (the first real fix will)
      .filter((l) => l.kind === "live" && !isPredictedLine(l) && l.minutes != null)
      .sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
    if (live[0]?.minutes === 0) {
      if (
        await send({ firedAt: now }, `🚐 The shuttle is here at <b>${esc(from)}</b> — hop on!`, `need-here:${sub.id}`)
      )
        out.fired++;
      continue;
    }
    if (sub.lastSentAt) continue;
    const near = live[0] && (live[0].minutes ?? Infinity) <= ON_THE_WAY_MIN;
    if (!heading.has(sub.workspaceId)) heading.set(sub.workspaceId, headingTo(db, sub.workspaceId, now));
    if (!near && !(await heading.get(sub.workspaceId))?.has(spotId)) continue;
    const eta = live[0] ? `, ${live[0].approx ? "about " : ""}${live[0].minutes} min` : "";
    const html = `🚐 The shuttle is on its way to <b>${esc(from)}</b>${eta}.`;
    if (await send({ lastSentAt: now }, html, `need-way:${sub.id}`)) out.onTheWay++;
  }
  return out;
}

/** Spots that a vehicle on a public service is driving to now (en route, pinged in the last 2 min). */
async function headingTo(db: Db, workspaceId: string, now: Date): Promise<Set<string>> {
  const rows = await db
    .select({ next: vehicleState.nextSpotId })
    .from(vehicleState)
    .innerJoin(services, eq(services.id, vehicleState.serviceId))
    .where(
      and(
        eq(vehicleState.workspaceId, workspaceId),
        eq(vehicleState.phase, "en_route"),
        eq(services.public, true),
        gt(vehicleState.lastPingAt, new Date(now.getTime() - FRESH_MS)),
      ),
    );
  return new Set(rows.flatMap((r) => (r.next ? [r.next] : [])));
}

/** Active vehicles of the workspace with their live state (spot names resolved) and any break, for the ops alert. */
async function alertVehicles(db: Db, workspaceId: string, now: Date): Promise<AlertVehicle[]> {
  const nextSpots = alias(spots, "next_spots");
  const rows = await db
    .select({
      name: vehicles.name,
      vehicleId: vehicles.id,
      state: vehicleState,
      at: spots.shortName,
      next: nextSpots.shortName,
    })
    .from(vehicles)
    .leftJoin(vehicleState, eq(vehicleState.vehicleId, vehicles.id))
    .leftJoin(spots, eq(spots.id, vehicleState.spotId))
    .leftJoin(nextSpots, eq(nextSpots.id, vehicleState.nextSpotId))
    .where(and(eq(vehicles.workspaceId, workspaceId), eq(vehicles.active, true)))
    .orderBy(asc(vehicles.name));
  const breaks = await activeBreaks(db, workspaceId, now);
  return rows.map((r) => {
    const brk = breaks.get(r.vehicleId);
    return {
      name: r.name,
      phase: r.state?.phase ?? null,
      spotName: r.at,
      nextSpotName: r.next,
      etaS: r.state?.etaS ?? null,
      lastPingAt: r.state?.lastPingAt ?? null,
      ...(brk ? { breakUntil: breakEnd(brk) } : {}),
    };
  });
}

/** viewer+. Open pickup requests (not fired, cancelled or expired) per stop, for the Live board and MCP. */
export async function waitingAtSpots(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<WaitingSpot[]> {
  readable(actor, input.workspaceId);
  const rows = await db
    .select({ sub: subscriptions, person: people, from: spots.shortName, to: toSpots.shortName })
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.personId))
    .innerJoin(spots, eq(spots.id, subscriptions.spotId))
    .innerJoin(toSpots, eq(toSpots.id, subscriptions.toSpotId))
    .where(and(eq(subscriptions.workspaceId, input.workspaceId), eq(subscriptions.kind, "pickup"), openAt(now)))
    .orderBy(asc(subscriptions.createdAt));
  return groupWaiting(
    rows.map((r) => ({
      requestId: r.sub.id,
      spotId: r.sub.spotId as string,
      spotName: r.from,
      name: requesterName(r.person),
      toSpotName: r.to,
      since: r.sub.createdAt,
    })),
  );
}
