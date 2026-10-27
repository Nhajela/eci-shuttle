/**
 * svc-bot: Telegram live location as a driver's phone (for drivers without our Android app, e.g. on an iPhone).
 * "/pair 123456" pairs a device from an admin's pairing code, linked to the sender; each live-location update
 * (message.location with live_period, then edited_message.location) becomes one ping through the normal
 * devices/sync path, like the Traccar adapter (app/api/device/traccar).
 */
import { type Ping, resolveMode, type SyncRequest } from "@eci-shuttle/shared";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { auditLog, deviceAssignments, devices, vehicles } from "@/db/schema";
import { escapeHtml } from "@/lib/telegram/html";
import { desiredConfig } from "../devices/config";
import { pairDevice } from "../devices/pairing";
import { syncDevice } from "../devices/sync";
import { type Actor, mutate } from "../kernel";
import type { BotContext, BotReply, TgMessage } from "./types";

export const TELEGRAM_MODEL = "Telegram live location";
/** devices.token_hash marker for the Telegram person a device is linked to (see pairing.pairDevice `link`) */
const linkOf = (telegramId: number) => `telegram:${telegramId}`;

const NONE: BotReply = { send: [] };
const say = (chatId: number, html: string): BotReply => ({ send: [{ chatId, html, kind: "reply" }] });

const HOW_TO_SHARE =
  "In this chat, tap 📎 (attach) → <b>Location</b> → <b>Share My Live Location</b> → " +
  "<b>until I turn it off</b> (or 8 hours).\nKeep Telegram allowed to use location while you drive.";

const UNASSIGNED = "This phone isn't on a shuttle yet — ask the shuttle team to assign it.";
const KILLED = "The shuttle team has paused your tracking.";
const REVOKED = "This phone has been removed from the shuttle. Ask the shuttle team for a new pairing code.";
const STOPPED = `Your live location stopped, so the shuttle can't see you. To start again:\n${HOW_TO_SHARE}`;
/** audit action that remembers "the driver was told this" (see tellOnce) */
const NOTIFIED = "device.driver_notified";

/**
 * Replies `html` once per `key` for this device. Live updates arrive every few seconds, so "told already" has to be
 * remembered: one audit row (action device.driver_notified, after.key) per notice, written by the device itself, no
 * schema. The device row is locked so two racing updates tell the driver once.
 */
async function tellOnce(db: Db, actor: Actor, chatId: number, key: string, html: string): Promise<BotReply> {
  return db.transaction(async (tx) => {
    await tx.select({ id: devices.id }).from(devices).where(eq(devices.id, actor.id)).for("update");
    const [seen] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entity, "device"),
          eq(auditLog.entityId, actor.id),
          eq(auditLog.action, NOTIFIED),
          sql`${auditLog.after}->>'key' = ${key}`,
        ),
      )
      .limit(1);
    if (seen) return NONE;
    await mutate(
      tx,
      actor,
      { action: NOTIFIED, entity: "device", entityId: actor.id, workspaceId: actor.workspaceId ?? null },
      async () => ({ before: null, after: { key }, result: undefined }),
    );
    return say(chatId, html);
  });
}

/** "/pair 123456" (private chat): pair this Telegram account as a phone in the code's workspace. */
export async function onPair(ctx: BotContext, code: string | null): Promise<BotReply> {
  if (!code) return say(ctx.chatId, "Send the pairing code from admin like this: /pair 123456");
  const p = ctx.person;
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username || undefined;
  const { deviceId } = await pairDevice(
    ctx.db,
    { code, model: TELEGRAM_MODEL, appVersion: "telegram", updateId: null, pushToken: null },
    ctx.now,
    { link: linkOf(p.telegramId), label: name },
  );
  const [on] = await ctx.db
    .select({ vehicle: vehicles.name })
    .from(deviceAssignments)
    .innerJoin(vehicles, eq(vehicles.id, deviceAssignments.vehicleId))
    .where(and(eq(deviceAssignments.deviceId, deviceId), isNull(deviceAssignments.endsAt)));
  const where = on ? `It's on ${escapeHtml(on.vehicle)}.` : UNASSIGNED;
  return say(
    ctx.chatId,
    `Paired ✅ ${name ? `${escapeHtml(name)}, now` : "Now"} share your live location:\n${HOW_TO_SHARE}\n\n${where}`,
  );
}

/** Telegram's location → a ping; recorded at the edit time for updates. No live_period on a new message → null. */
export function pingOf(msg: TgMessage): Ping | null {
  const loc = msg.location;
  if (!loc || (!msg.edit_date && !loc.live_period)) return null;
  const heading = loc.heading;
  return {
    recordedAt: (msg.edit_date ?? msg.date) * 1000,
    lat: loc.latitude,
    lng: loc.longitude,
    accuracy: loc.horizontal_accuracy ?? 50,
    speed: null,
    heading: heading !== undefined && heading >= 0 && heading <= 360 ? heading : null,
    battery: null,
  };
}

/**
 * Bot API: while sharing, every edit keeps live_period. When it stops (the driver turns it off, or the period runs
 * out) the last edit comes without live_period, or at/after date + live_period. A first message is never a stop.
 */
export function isLiveStop(msg: TgMessage): boolean {
  const loc = msg.location;
  if (!loc || !msg.edit_date) return false;
  return !loc.live_period || msg.edit_date >= msg.date + loc.live_period;
}

/**
 * A message or edited_message from anyone. Not a paired sender, or no location → nothing. A static location →
 * a hint to share it live. A live one → syncDevice as an always-on, up-to-date phone (it can't take our config).
 * The first live message gets a confirmation; updates get no reply, except once each (tellOnce) when the phone is
 * killed, revoked or on no vehicle (nothing is tracked), or when sharing stopped during a tracking window (how to restart). The final
 * stop edit is still synced: it is the last real position, and sync drops it for a killed/revoked phone.
 */
export async function onLocation(db: Db, msg: TgMessage, now: Date): Promise<BotReply> {
  if (!msg.location || !msg.from) return NONE;
  const [d] = await db
    .select({
      id: devices.id,
      workspaceId: devices.workspaceId,
      label: devices.label,
      killedAt: devices.killedAt,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(eq(devices.tokenHash, linkOf(msg.from.id)));
  if (!d) return NONE;
  const ping = pingOf(msg);
  if (!ping) return say(msg.chat.id, `That's a one-off location. For the shuttle, share it live:\n${HOW_TO_SHARE}`);
  const actor: Actor = { kind: "device", id: d.id, workspaceId: d.workspaceId, channel: "device", label: d.label };
  const input: SyncRequest = {
    pings: [ping],
    battery: null,
    charging: null,
    permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
    reportedMode: "active",
    // can't apply our config (no modes, kill or OTA); report "up to date" so admin doesn't flag it forever
    appliedConfigVersion: 2_147_483_647,
    appVersion: "telegram",
    updateId: null,
    clock: now.getTime(),
  };
  await syncDevice(db, actor, input, now);

  const share = `${msg.chat.id}:${msg.message_id}`; // one live share = one message; its edits share the key
  const [open] = await db
    .select({ id: deviceAssignments.id })
    .from(deviceAssignments)
    .where(and(eq(deviceAssignments.deviceId, d.id), isNull(deviceAssignments.endsAt)))
    .limit(1);
  if (d.revokedAt) return tellOnce(db, actor, msg.chat.id, `revoked:${share}`, REVOKED);
  if (d.killedAt) return tellOnce(db, actor, msg.chat.id, `killed:${+d.killedAt}:${share}`, KILLED);
  if (!open) {
    // a later "unassigned" is a new one: keyed on when the last assignment ended (none = never assigned)
    const [{ last }] = await db
      .select({ last: max(deviceAssignments.endsAt) })
      .from(deviceAssignments)
      .where(eq(deviceAssignments.deviceId, d.id));
    return tellOnce(db, actor, msg.chat.id, `unassigned:${last ? +last : "never"}:${share}`, UNASSIGNED);
  }
  if (isLiveStop(msg)) {
    // ending a share off shift is normal (end of the day): only prompt a restart while the server wants fixes
    const config = await desiredConfig(db, d.id, now);
    return resolveMode(config, now.getTime()).mode === "active"
      ? tellOnce(db, actor, msg.chat.id, `ended:${share}`, STOPPED)
      : NONE;
  }
  return msg.edit_date ? NONE : say(msg.chat.id, "Got your live location 📍 Keep sharing while you drive.");
}
