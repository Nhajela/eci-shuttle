/**
 * svc-subscriptions: attendee alerts from the bot (SPEC §6c For attendees, §3 subscriptions).
 * - arrival_alert: one-shot "message me when the shuttle is N min from <spot>", expires after at most 2 h.
 * - notices: notices for one spot, or all spots (spot_id null).
 * Attendee writes are audited (subscription.*) with the attendee actor. Firing and expiry are bookkeeping by
 * the worker (fired_at / cancelled_at), not audited.
 */
import { notImplemented } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { Person, Subscription } from "@/db/types";
import type { Actor } from "../kernel";

export const ARRIVAL_ALERT_MAX_MS = 2 * 60 * 60_000;
export const DEFAULT_LEAD_MIN = 5;

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
  return notImplemented(db, actor, input, now);
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
  return notImplemented(db, actor, input, now);
}

/** Attendee: cancel one of their own (another person's → NOT_FOUND), or all when subscriptionId is "all". */
export async function unsubscribe(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; subscriptionId: string | "all" },
  now: Date,
): Promise<number> {
  return notImplemented(db, actor, input, now);
}

/** Attendee: their open subscriptions (not fired, cancelled or expired at now). */
export async function mySubscriptions(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<Subscription[]> {
  return notImplemented(db, actor, input, now);
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
  return notImplemented(db, input, now);
}

/**
 * Who gets a notice by Telegram (the notices job): people with an open `notices` subscription for any of
 * spotIds, or for all spots; "all" (an `everywhere` notice) = every notices subscriber. Blocked-bot people are
 * left out. Distinct people.
 */
export async function noticeRecipients(db: Db, workspaceId: string, spotIds: string[] | "all"): Promise<Person[]> {
  return notImplemented(db, workspaceId, spotIds);
}

/** viewer+. People page: open subscriptions per spot (spotId null = all-spot notice subscribers). */
export async function subscriberCounts(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<{ spotId: string | null; notices: number; arrivalAlerts: number }[]> {
  return notImplemented(db, actor, input, now);
}
