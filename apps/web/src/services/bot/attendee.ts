/**
 * svc-bot: attendee side (SPEC §6c For attendees). The same answer as the public page (public/status), never
 * lateness. Writes go through svc-subscriptions with auth/actor.attendeeActor.
 */
import { type AnswerLine, notImplemented } from "@eci-shuttle/shared";
import type { Callback } from "./callbacks";
import type { BotContext, BotReply, TgCallbackQuery } from "./types";

/** `/shuttle [spot]`: the spot buttons (spots with a public service today), or that spot's answer. */
export async function onShuttle(ctx: BotContext, arg: string | null): Promise<BotReply> {
  return notImplemented(ctx, arg);
}

/**
 * A spot's answer (public/status.spotAnswer) rendered with renderAnswer, with buttons:
 * [Tell me when it's close] [Notices for <spot>] and the other spots.
 */
export async function onSpot(ctx: BotContext, spotId: string): Promise<BotReply> {
  return notImplemented(ctx, spotId);
}

/**
 * Pure. Telegram HTML for one spot, one line per service, like the page:
 * "<b>Riva</b>\nTo Circle: here in <b>6 min</b> (5–9) · live\nParty shuttle: next scheduled 22:00 · live tracking off".
 * Escapes names. Never says late/behind.
 */
export function renderAnswer(spotName: string, lines: AnswerLine[]): string {
  return notImplemented(spotName, lines);
}

/** `/stop`: cancel all of the person's subscriptions (subscriptions.unsubscribe "all"). */
export async function onStop(ctx: BotContext): Promise<BotReply> {
  return notImplemented(ctx);
}

/** Buttons spot / arrive / nsub / nunsub. */
export async function onAttendeeCallback(ctx: BotContext, cb: Callback, query: TgCallbackQuery): Promise<BotReply> {
  return notImplemented(ctx, cb, query);
}
