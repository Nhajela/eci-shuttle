/**
 * svc-bot: Telegram live location as a driver's phone (for drivers without our Android app, e.g. on an iPhone).
 * "/pair 123456" pairs a device from an admin's pairing code, linked to the sender; each live-location update
 * (message.location with live_period, then edited_message.location) becomes one ping through the normal
 * devices/sync path, like the Traccar adapter (app/api/device/traccar).
 */
import type { Ping, SyncRequest } from "@eci-shuttle/shared";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { devices } from "@/db/schema";
import { escapeHtml } from "@/lib/telegram/html";
import { pairDevice } from "../devices/pairing";
import { syncDevice } from "../devices/sync";
import type { Actor } from "../kernel";
import type { BotContext, BotReply, TgMessage } from "./types";

export const TELEGRAM_MODEL = "Telegram live location";
/** devices.token_hash marker for the Telegram person a device is linked to (see pairing.pairDevice `link`) */
const linkOf = (telegramId: number) => `telegram:${telegramId}`;

const NONE: BotReply = { send: [] };
const say = (chatId: number, html: string): BotReply => ({ send: [{ chatId, html, kind: "reply" }] });

const HOW_TO_SHARE =
  "In this chat, tap 📎 (attach) → <b>Location</b> → <b>Share My Live Location</b> → " +
  "<b>until I turn it off</b> (or 8 hours).\nKeep Telegram allowed to use location while you drive.";

/** "/pair 123456" (private chat): pair this Telegram account as a phone in the code's workspace. */
export async function onPair(ctx: BotContext, code: string | null): Promise<BotReply> {
  if (!code) return say(ctx.chatId, "Send the pairing code from admin like this: /pair 123456");
  const p = ctx.person;
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username || undefined;
  await pairDevice(
    ctx.db,
    { code, model: TELEGRAM_MODEL, appVersion: "telegram", updateId: null, pushToken: null },
    ctx.now,
    { link: linkOf(p.telegramId), label: name },
  );
  return say(
    ctx.chatId,
    `Paired ✅ ${name ? `${escapeHtml(name)}, now` : "Now"} share your live location:\n${HOW_TO_SHARE}`,
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
 * A message or edited_message from anyone. Not a paired sender, or no location → nothing. A static location →
 * a hint to share it live. A live one → syncDevice as an always-on, up-to-date phone (it can't take our config).
 * The first live message gets a confirmation; updates get no reply.
 */
export async function onLocation(db: Db, msg: TgMessage, now: Date): Promise<BotReply> {
  if (!msg.location || !msg.from) return NONE;
  const [d] = await db
    .select({ id: devices.id, workspaceId: devices.workspaceId, label: devices.label })
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
  return msg.edit_date ? NONE : say(msg.chat.id, "Got your live location 📍 Keep sharing while you drive.");
}
