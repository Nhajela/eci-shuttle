/**
 * svc-bot: admin side (SPEC §6c For admins). Quick commands only; anything bigger is done in admin or by MCP.
 * Each builds the actor with auth/actor.adminActor(channel "telegram"); no membership → "This is for the ops team."
 * An optional trailing workspace slug picks a test workspace ("/status test").
 */
import { notImplemented } from "@eci-shuttle/shared";
import type { Callback } from "./callbacks";
import type { BotContext, BotReply, TgCallbackQuery } from "./types";

/** `/status [slug]`: each vehicle's phase, ETA, last seen, battery (IST times), then open problems (alerts/watchdog). viewer+. */
export async function onStatus(ctx: BotContext, args: string[]): Promise<BotReply> {
  return notImplemented(ctx, args);
}

/** `/today [slug]`: today's services and departures, with exceptions marked. viewer+. */
export async function onToday(ctx: BotContext, args: string[]): Promise<BotReply> {
  return notImplemented(ctx, args);
}

/**
 * `/silence <vehicle> <until> [slug]`: vehicle by name (case-insensitive prefix), until "HH:MM" IST (next
 * occurrence) or "<n>h" / "<n>m"; silences that vehicle's phone (devices/phones.silencePhone). ops+.
 */
export async function onSilence(ctx: BotContext, args: string[]): Promise<BotReply> {
  return notImplemented(ctx, args);
}

/**
 * `/notice <text>`: a wizard over buttons (placement → duration → severity → channels → Post), editing one
 * preview message. Stateless: the draft is read back from the preview message's own text at each step, choices
 * ride in callback data. Post → notices.createNotice. ops+.
 */
export async function onNotice(ctx: BotContext, text: string): Promise<BotReply> {
  return notImplemented(ctx, text);
}

/**
 * Buttons nudge / sil1h / kill → killok / cday → cdayok / nw / noop. Destructive ones (kill, cday) first edit the
 * message into "Are you sure?" with [Yes, kill] [Cancel]; only the *ok action changes anything.
 */
export async function onAdminCallback(ctx: BotContext, cb: Callback, query: TgCallbackQuery): Promise<BotReply> {
  return notImplemented(ctx, cb, query);
}
