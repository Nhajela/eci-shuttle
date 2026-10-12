/**
 * svc-alerts: ops alerts to admins on Telegram (SPEC §6c For admins). Sent through the outbox, so an alert exists
 * iff the change or detection that caused it committed. Per workspace, so test alerts never reach real ops.
 * Event-driven kinds are raised by the service that sees the event, inside its transaction: kill_resume
 * (devices/phones kill, devices/sync resume), update_failed and permission_lost (devices/sync). Watchdog kinds
 * come from alerts/watchdog.
 */
import { type AlertKind, formatIst, istDate, istHHMM } from "@eci-shuttle/shared";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { Db } from "@/db";
import { alertPrefs, auditLog, memberships, people, workspaces } from "@/db/schema";
import { origin } from "@/lib/env";
import { getInsights, listSuggestions } from "@/services/learning/insights";
import { enqueue, systemActor, type TelegramButton } from "../kernel";
import { DEFAULT_ALERT_KINDS, quietUntil } from "./prefs";

export type AlertEvent = {
  workspaceId: string;
  kind: AlertKind;
  /**
   * Stable per problem episode, so each problem alerts once: e.g. `silent:<vehicleId>:<sinceMs>`,
   * `kill:<deviceId>:<auditId>`. Becomes dedupeKey `alert:<key>:<personId>`.
   */
  key: string;
  /** Telegram HTML, already escaped; times in IST */
  html: string;
  /**
   * The obvious next step (SPEC §6c): bot/callbacks-encoded "Nudge phone" / "Silence 1h" and a URL button
   * "Open in admin" (<origin>/admin/<page>?w=<slug>). Destructive buttons always go through a confirm step.
   */
  buttons?: TelegramButton[][];
};

/** Telegram HTML escape for text people typed (labels, names). */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** URL button to an admin page of the workspace. */
export async function adminButton(db: Db, workspaceId: string, page: string): Promise<TelegramButton> {
  const [ws] = await db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return { text: "Open in admin", url: `${origin()}/admin/${page}?w=${encodeURIComponent(ws?.slug ?? "")}` };
}

async function queueAlert(db: Db, event: AlertEvent, now: Date, skipPersonId?: string): Promise<number> {
  const members = await db
    .select({ person: people, prefs: alertPrefs })
    .from(memberships)
    .innerJoin(people, eq(people.id, memberships.personId))
    .leftJoin(alertPrefs, and(eq(alertPrefs.personId, people.id), eq(alertPrefs.workspaceId, event.workspaceId)))
    .where(and(eq(memberships.workspaceId, event.workspaceId), isNull(people.blockedBotAt)));
  let queued = 0;
  for (const { person, prefs } of members) {
    if (person.id === skipPersonId || !(prefs?.kinds ?? DEFAULT_ALERT_KINDS).includes(event.kind)) continue;
    const held = quietUntil(prefs?.quietFrom ?? null, prefs?.quietTo ?? null, now.getTime());
    const job = await enqueue(db, {
      kind: "telegram",
      workspaceId: event.workspaceId,
      dedupeKey: `alert:${event.key}:${person.id}`,
      runAfter: held === null ? now : new Date(held),
      payload: {
        chatId: person.telegramId,
        html: event.html,
        kind: event.kind === "digest" ? "digest" : "alert",
        ...(event.buttons ? { buttons: event.buttons } : {}),
        personId: person.id,
      },
    });
    if (job) queued++;
  }
  return queued;
}

/**
 * Enqueue the alert (telegram, kind "alert") for every member of the workspace whose prefs (alerts/prefs, defaults
 * when no row) include event.kind and who hasn't blocked the bot; run_after = quietUntil(...) ?? now. Works in the
 * caller's transaction. Returns how many were queued (0 for repeats of the same key).
 */
export async function raiseAlert(db: Db, event: AlertEvent, now: Date): Promise<number> {
  return queueAlert(db, event, now);
}

/**
 * admin_changes: audit rows of the workspace with at in (since, now] made by admin actors, one alert per row to
 * members opted in, never to the row's author (dedupe per audit id). Called by the watchdog job with
 * since = now − 2 min (the dedupe makes overlap harmless).
 */
export async function alertAdminChanges(db: Db, workspaceId: string, since: Date, now: Date): Promise<number> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, workspaceId),
        eq(auditLog.actorKind, "admin"),
        gt(auditLog.at, since),
        lte(auditLog.at, now),
      ),
    )
    .orderBy(auditLog.id);
  if (!rows.length) return 0;
  const open = await adminButton(db, workspaceId, "activity");
  let queued = 0;
  for (const r of rows) {
    const who = escapeHtml(r.actorLabel ?? "Someone");
    const html = `<b>${who}</b> ${escapeHtml(r.action)} (${escapeHtml(r.entity)}) at ${istHHMM(r.at)} via ${escapeHtml(r.channel)}`;
    queued += await queueAlert(
      db,
      { workspaceId, kind: "admin_changes", key: `admin:${r.id}`, html, buttons: [[open]] },
      now,
      r.actorId,
    );
  }
  return queued;
}

/**
 * Nightly digest (learning job, after recomputeAll): yesterday's insights in a few lines and the open
 * timetable suggestions, to members opted into "digest". Dedupe `digest:<workspaceId>:<IST date>`.
 */
export async function sendDigest(db: Db, workspaceId: string, now: Date): Promise<number> {
  const actor = systemActor("learning");
  const yesterday = istDate(now.getTime() - 86_400_000);
  const insights = await getInsights(db, actor, { workspaceId, from: yesterday, to: yesterday });
  const open = await listSuggestions(db, actor, { workspaceId, status: "open" });
  const n = insights.onTime.reduce((s, x) => s + x.n, 0);
  const onTime = n ? Math.round(insights.onTime.reduce((s, x) => s + x.pct * x.n, 0) / n) : null;
  const lines = [
    `<b>Yesterday, ${formatIst(now.getTime() - 86_400_000).split(",")[0]}</b>`,
    onTime === null ? "No departures measured." : `${onTime}% of departures on time (${n} measured).`,
    `Live tracking covered ${Math.round(insights.trackedPct)}% of service time.`,
    open.length
      ? `${open.length} open timetable suggestion${open.length === 1 ? "" : "s"}:`
      : "No open timetable suggestions.",
    ...open.slice(0, 5).map((s) => `• ${escapeHtml(s.summary)}`),
  ];
  const buttons = open.length ? [[await adminButton(db, workspaceId, "insights")]] : undefined;
  return queueAlert(
    db,
    { workspaceId, kind: "digest", key: `digest:${workspaceId}:${istDate(now)}`, html: lines.join("\n"), buttons },
    now,
  );
}
