/**
 * svc-subscriptions: `/subscribe` — a Telegram update every 15 min with a stop's answer (or every stop's), sent
 * only while a shuttle is running there. One open `updates` subscription per person; /stop or the button ends it.
 * Subscribing is audited (subscription.create); sending is worker bookkeeping (last_sent_at), not audited.
 */
import { istDate, type PublicSpot, type PublicStatus } from "@eci-shuttle/shared";
import { and, desc, eq, gt, inArray, isNull, like, lte, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import {
  outbox,
  people,
  routes,
  services,
  serviceVehicles,
  spots,
  subscriptions,
  vehicleState,
  vehicles,
} from "@/db/schema";
import type { Subscription } from "@/db/types";
import { encodeCallback } from "../bot/callbacks";
import { type Gif, gifUrl } from "../bot/gifs";
import { activeBreaks, breakEnd } from "../catalog/breaks";
import { type Actor, enqueue, getInWorkspace, mutate, parseInput, ServiceError, type TelegramButton } from "../kernel";
import { FRESH_MS, sight } from "../public/sight";
import { publicStatus } from "../public/status";
import { allUnseen, departedSince, type ShuttleNow, storyKey, storyText } from "./update-text";

export const UPDATE_EVERY_MS = 15 * 60_000;
/** the rhythms a person can pick (schema CHECK subscriptions_every_min); 15 is the default */
export const UPDATE_EVERY_MIN = [15, 30] as const;
export type UpdateEveryMin = (typeof UPDATE_EVERY_MIN)[number];
/** the worker runs every minute: a few seconds early still counts as due */
const SLACK_MS = 30_000;
/** with nothing new, a short check-in this often (never while nothing is in sight: that was said once) */
export const CHECK_IN_MS = 30 * 60_000;

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
          // the rhythm they chose stays when they switch stop
          everyMin: existing?.everyMin ?? 15,
          lastSentAt: now,
          createdAt: now,
        })
        .returning();
      return { before: null, after: row, result: row };
    },
  );
}

/** The button that switches to the other rhythm: 🐢 calmer for a 15-min subscriber, 🐇 every move for a 30-min one. */
export function rhythmButton(everyMin: number): TelegramButton {
  return everyMin === 30
    ? { text: "🐇 Every move", callbackData: encodeCallback({ action: "every", args: ["15"] }) }
    : { text: "🐢 Calmer: every 30 min", callbackData: encodeCallback({ action: "every", args: ["30"] }) };
}

/** How often updates come, for "an update for every stop <rhythmText> while the shuttle runs" (runUpdates). */
export const rhythmText = (everyMin: number) =>
  everyMin === 30
    ? "every 30 min, and when something changes,"
    : "whenever the shuttle leaves a stop, with a check-in every 30 min,";

export const SetUpdateEveryInput = z.object({
  workspaceId: z.uuid(),
  everyMin: z.union([z.literal(15), z.literal(30)]),
});

/**
 * Attendee: how often the updates come, every 15 min (default) or every 30 min, on their open updates
 * subscription (none → NOT_FOUND: /start first). The same value again changes nothing. Audited subscription.update.
 */
export async function setUpdateEvery(
  db: Db,
  actor: Actor,
  input: z.input<typeof SetUpdateEveryInput>,
  now: Date,
): Promise<Subscription> {
  const i = parseInput(SetUpdateEveryInput, input);
  if (actor.kind !== "attendee" || (actor.workspaceId && actor.workspaceId !== i.workspaceId))
    throw new ServiceError("FORBIDDEN", "Not allowed.");
  const mine = and(
    eq(subscriptions.personId, actor.id),
    eq(subscriptions.workspaceId, i.workspaceId),
    eq(subscriptions.kind, "updates"),
    open,
  );
  const [existing] = await db.select().from(subscriptions).where(mine).limit(1);
  if (!existing) throw new ServiceError("NOT_FOUND", "You're not getting updates right now. Send /start first.");
  if (existing.everyMin === i.everyMin) return existing;
  return mutate(
    db,
    actor,
    { action: "subscription.update", entity: "subscription", entityId: existing.id, workspaceId: i.workspaceId },
    async (tx) => {
      const [row] = await tx
        .update(subscriptions)
        .set({ everyMin: i.everyMin })
        .where(eq(subscriptions.id, existing.id))
        .returning();
      if (!row) throw new ServiceError("NOT_FOUND", "You're not getting updates right now. Send /start first.");
      return { before: { everyMin: existing.everyMin }, after: { everyMin: row.everyMin }, result: row };
    },
  );
}

/** Attendee: end their 15-min updates. Returns how many were open. Audited subscription.cancel. */
export async function unsubscribeUpdates(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<number> {
  if (actor.kind !== "attendee" || (actor.workspaceId && actor.workspaceId !== input.workspaceId))
    throw new ServiceError("FORBIDDEN", "Not allowed.");
  const mine = and(
    eq(subscriptions.personId, actor.id),
    eq(subscriptions.workspaceId, input.workspaceId),
    eq(subscriptions.kind, "updates"),
    open,
  );
  const [any] = await db.select({ id: subscriptions.id }).from(subscriptions).where(mine).limit(1);
  if (!any) return 0;
  return mutate(
    db,
    actor,
    { action: "subscription.cancel", entity: "subscription", entityId: any.id, workspaceId: input.workspaceId },
    async (tx) => {
      const rows = await tx.update(subscriptions).set({ cancelledAt: now }).where(mine).returning();
      return { before: { open: rows.length }, after: { open: 0 }, result: rows.length };
    },
  );
}

/** Pure. Nothing more today at any of these stops (every line "no more shuttles today", or none run today). */
export function dayOver(list: PublicSpot[]): boolean {
  return list.every((s) => s.answers.every((l) => l.kind === "none"));
}

export const DAY_OVER_LEAD = "🌙 The shuttle has finished for today — the vans are tucked in for the night.";
export const DAY_OVER_TEXT = `${DAY_OVER_LEAD} Updates start again when it runs tomorrow. /unsubscribe stops them.`;

/** the "on its way to your stop" GIF comes at most this often per subscriber */
const ON_THE_WAY_GIF_EVERY_MS = 60 * 60_000;

/**
 * Pure. The GIF moment of an update, if any (SPEC §6c; sparing, no schema: everything is derived):
 * - `break`: the first update that mentions a break, i.e. one that started after the subscription's last update;
 *   the next 15-min tick of the same break has no GIF;
 * - `on-the-way`: a departure push (`departed`: a shuttle just left a stop) to a one-stop subscriber whose stop
 *   is where that shuttle is heading. runUpdates adds "at most once an hour" from the outbox (`sentGifSince`).
 * The welcome and the goodnight GIFs are decided where those messages are made.
 */
export function updateGif(input: {
  shuttles: ShuttleNow[];
  focusSpotId: string | null;
  lastSentAt: number;
  departed: boolean;
}): Gif | null {
  const { shuttles, focusSpotId, lastSentAt, departed } = input;
  if (
    departed &&
    focusSpotId &&
    shuttles.some((s) => s.state.kind === "moving" && s.state.toSpotId === focusSpotId && s.state.since > lastSentAt)
  )
    return "on-the-way";
  if (shuttles.some((s) => s.state.kind === "break" && s.state.since > lastSentAt)) return "break";
  return null;
}

/**
 * An update to this subscription with that GIF was queued after `since` (the outbox keeps a day or so). By the
 * job's run_after (= the job's `now`), not the row's wall-clock created_at, so the rule follows the job's clock.
 */
async function sentGifSince(db: Db, subscriptionId: string, gif: Gif, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        like(outbox.dedupeKey, `update:${subscriptionId}:%`),
        gt(outbox.runAfter, since),
        sql`${outbox.payload} ->> 'animation' = ${gifUrl(gif)}`,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * The storyKey of this subscription's last update (in its outbox dedupe key: `update:<sub>:<ms>:<key>`), or null
 * when there is none (the outbox keeps a day or so; older rows carry no key).
 */
async function lastStoryKey(db: Db, subscriptionId: string): Promise<string | null> {
  const [row] = await db
    .select({ key: outbox.dedupeKey })
    .from(outbox)
    .where(and(like(outbox.dedupeKey, `update:${subscriptionId}:%`), sql`${outbox.dedupeKey} not like '%:end:%'`))
    .orderBy(desc(outbox.runAfter))
    .limit(1);
  const parts = row?.key?.split(":") ?? [];
  return parts.length >= 4 ? parts.slice(3).join(":") : null;
}

/**
 * What each shuttle on a public service running now is doing (update-text.ShuttleNow): waiting at a stop, on its
 * way (or paused: the public answer says "stopped on the way"), off its route, on a driver's break, or, by how long
 * we haven't seen it (public/sight.ts): parked at a stop, out of sight, or hidden. A short drop (≤ 5 min) keeps its
 * last phase. No actor: like public/status, it only reads what attendees may know.
 */
export async function shuttlesNow(db: Db, workspaceId: string, st: PublicStatus, now: Date): Promise<ShuttleNow[]> {
  const serviceIds = [...new Set(st.spots.flatMap((s) => s.answers.map((l) => l.serviceId)))];
  if (!serviceIds.length) return [];
  const rows = await db
    .select({ serviceId: serviceVehicles.serviceId, vehicle: vehicles, state: vehicleState, route: routes })
    .from(serviceVehicles)
    .innerJoin(vehicles, eq(vehicles.id, serviceVehicles.vehicleId))
    .innerJoin(services, eq(services.id, serviceVehicles.serviceId))
    .innerJoin(routes, eq(routes.id, services.routeId))
    .leftJoin(vehicleState, eq(vehicleState.vehicleId, vehicles.id))
    .where(
      and(
        eq(serviceVehicles.workspaceId, workspaceId),
        inArray(serviceVehicles.serviceId, serviceIds),
        lte(serviceVehicles.startsAt, now),
        gt(serviceVehicles.endsAt, now),
        eq(vehicles.active, true),
      ),
    );
  const breaks = await activeBreaks(db, workspaceId, now);
  const paused = (name: string) =>
    st.spots.some((s) => s.answers.some((l) => l.vehicleName === name && l.phaseText === "stopped on the way"));
  const out: ShuttleNow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const s = r.state;
    // a vehicle answers only for the service it is running now (as public/status), once
    if ((s?.serviceId && s.serviceId !== r.serviceId) || seen.has(r.vehicle.id)) continue;
    seen.add(r.vehicle.id);
    const brk = breaks.get(r.vehicle.id);
    const v = sight(s, now.getTime());
    const live = v.kind === "live" ? v.state : null;
    const seenAgoMs = v.kind === "live" && v.ageMs > FRESH_MS ? v.ageMs : undefined;
    let state: ShuttleNow["state"];
    if (brk) state = { kind: "break", until: breakEnd(brk)?.getTime() ?? null, since: brk.startsAt.getTime() };
    else if (v.kind === "hidden") state = { kind: "hidden", last: v.last };
    else if (v.kind === "parked") state = { kind: "parked", spotId: v.spotId, last: v.last };
    else if (!live) state = { kind: "no_signal", last: v.kind === "lost" ? v.last : null };
    else if (live.offRoute) state = { kind: "off_route" };
    else if (live.phase === "at_spot" && live.spotId)
      state = { kind: "waiting", spotId: live.spotId, since: live.since.getTime(), seenAgoMs };
    else if (live.phase === "en_route" && live.nextSpotId)
      state = {
        kind: "moving",
        toSpotId: live.nextSpotId,
        fromSpotId: live.spotId,
        since: live.since.getTime(),
        stopped: paused(r.vehicle.name),
        seenAgoMs,
      };
    else state = { kind: "no_signal", last: null };
    out.push({
      name: r.vehicle.name,
      serviceId: r.serviceId,
      routeSpotIds: r.route.spotIds,
      legS: r.route.typicalLegS.map((x) => x ?? 0),
      state,
    });
  }
  return out;
}

/** The update for one subscription's stops now (update-text.storyText); null when no shuttle runs there. */
export async function currentUpdate(
  db: Db,
  workspaceId: string,
  st: PublicStatus,
  focusSpotId: string | null,
  now: Date,
): Promise<string | null> {
  const shuttles = await shuttlesNow(db, workspaceId, st, now);
  return storyText({ shuttles, spots: st.spots, focusSpotId, now: now.getTime() });
}

/**
 * The updates job (every minute), over every open `updates` subscription (blocked-bot people skipped):
 * - the day's shuttles are over at its stop(s) and it got an update today → one "finished for today" message
 *   (day_ended_on = today); it stays on, so updates start again when the shuttle runs the next day;
 * - else, while a shuttle runs there, what the shuttle is doing now (update-text.storyText, with a "Stop updates"
 *   button) when there is news: its storyKey changed since the last update (out of sight, back in view, a break
 *   starts or ends, it reaches the subscriber's own stop, a shuttle joins or leaves the shift), or, on the 15-min
 *   rhythm, a shuttle left a stop (the update promised "as soon as it starts moving"). With no news, a check-in
 *   every 30 min, except while nothing is in sight (said once already). The 30-min rhythm is the calm one: no
 *   instant departure push, and its updates make no such promise. Without per-shuttle states (no vehicle on
 *   shift) it falls back to every every_min. last_sent_at moves only when something is sent, and only the run
 *   that moves it sends; the storyKey sent rides in the outbox dedupe key.
 * GIF moments (updateGif): the goodnight on "finished for today", the first update of a break, and "on its way to
 * your stop" for a one-stop subscriber at most once an hour.
 */
export async function runUpdates(
  db: Db,
  now: Date,
  input: { workspaceId?: string } = {},
): Promise<{ sent: number; ended: number }> {
  const open_ = await db
    .select({ sub: subscriptions, person: people })
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.personId))
    .where(
      and(
        eq(subscriptions.kind, "updates"),
        open,
        isNull(people.blockedBotAt),
        input.workspaceId ? eq(subscriptions.workspaceId, input.workspaceId) : undefined,
      ),
    );
  const statuses = new Map<string, ReturnType<typeof publicStatus>>();
  const fleets = new Map<string, Promise<ShuttleNow[]>>();
  let sent = 0;
  let ended = 0;
  for (const { sub, person } of open_) {
    if (!statuses.has(sub.workspaceId)) statuses.set(sub.workspaceId, publicStatus(db, sub.workspaceId, now));
    const st = await (statuses.get(sub.workspaceId) as ReturnType<typeof publicStatus>);
    const list = sub.spotId ? st.spots.filter((s) => s.spotId === sub.spotId) : st.spots;
    const today = istDate(now);
    // only after a day it got updates on, once: a day without shuttles, or after the goodbye, stays quiet
    const over = dayOver(list) && sub.dayEndedOn !== today && !!sub.lastSentAt && istDate(sub.lastSentAt) === today;
    if (dayOver(list) && !over) continue;
    if (!fleets.has(sub.workspaceId)) fleets.set(sub.workspaceId, shuttlesNow(db, sub.workspaceId, st, now));
    const shuttles = await (fleets.get(sub.workspaceId) as Promise<ShuttleNow[]>);
    const last = sub.lastSentAt?.getTime() ?? 0;
    // the instant "it just left" push belongs to the 15-min rhythm; 30 min is the calm one
    const instant = sub.everyMin === 15;
    const departed = instant && departedSince(shuttles, last);
    const key = shuttles.length ? storyKey(shuttles, sub.spotId) : null;
    let due: boolean;
    if (key === null) due = last <= now.getTime() - sub.everyMin * 60_000 + SLACK_MS || departed;
    else {
      // no earlier key (just subscribed: the reply showed where it was) → as if every shuttle was in sight
      const before =
        (await lastStoryKey(db, sub.id)) ??
        storyKey(
          shuttles.map((s) => ({
            ...s,
            state: { kind: "moving", toSpotId: "", fromSpotId: null, since: 0, stopped: false },
          })),
          sub.spotId,
        );
      const checkIn = last <= now.getTime() - CHECK_IN_MS + SLACK_MS && !allUnseen(key);
      due = before !== key || departed || checkIn;
    }
    const html = over
      ? DAY_OVER_TEXT
      : due
        ? storyText({ shuttles, spots: st.spots, focusSpotId: sub.spotId, now: now.getTime(), promise: instant })
        : null;
    if (!html) continue;
    let gif: Gif | null = over
      ? "goodnight"
      : updateGif({ shuttles, focusSpotId: sub.spotId, lastSentAt: last, departed });
    if (
      gif === "on-the-way" &&
      (await sentGifSince(db, sub.id, gif, new Date(now.getTime() - ON_THE_WAY_GIF_EVERY_MS)))
    )
      gif = null;
    const ok = await db.transaction(async (tx) => {
      const rows = await tx
        .update(subscriptions)
        .set(over ? { dayEndedOn: today } : { lastSentAt: now })
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
          ...(gif ? { animation: gifUrl(gif) } : {}),
          ...(over
            ? {}
            : {
                buttons: [
                  [{ text: "Stop updates", callbackData: encodeCallback({ action: "nunsub", args: [sub.id] }) }],
                  [rhythmButton(sub.everyMin)],
                ],
              }),
        },
        workspaceId: sub.workspaceId,
        dedupeKey: `update:${sub.id}:${over ? `end:${today}` : `${now.getTime()}${key === null ? "" : `:${key}`}`}`,
        runAfter: now,
      });
      return true;
    });
    if (ok) over ? ended++ : sent++;
  }
  return { sent, ended };
}
