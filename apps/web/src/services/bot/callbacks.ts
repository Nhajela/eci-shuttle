/**
 * svc-bot: inline-button callback_data. Format "<action>:<arg>:<arg>…", at most 64 bytes (Telegram); uuids in
 * full (36 chars), so one uuid plus a short arg fits. Every press goes through the service layer with channel
 * "telegram" and is audited like any other change (SPEC §6c).
 */
import { notImplemented } from "@eci-shuttle/shared";
import { z } from "zod";
import type { BotContext, BotReply, TgCallbackQuery } from "./types";

export const CallbackAction = z.enum([
  // attendee (bot/attendee)
  "spot", // spot:<spotId>               show that spot's answer
  "arrive", // arrive:<spotId>           tell me when it's close
  "nsub", // nsub:<spotId|all>           notices for a spot / all
  "nunsub", // nunsub:<subscriptionId|all>
  // admin (bot/admin)
  "nudge", // nudge:<deviceId>
  "sil1h", // sil1h:<deviceId>           silence 1 h
  "kill", // kill:<deviceId>             asks "Are you sure?"
  "killok", // killok:<deviceId>         confirmed
  "cday", // cday:<serviceId>:<YYYYMMDD> cancel a day, asks first
  "cdayok", // cdayok:<serviceId>:<YYYYMMDD>
  "nw", // nw:<step>:<value>             /notice wizard step
  "noop", // dismisses a confirm
]);
export type CallbackAction = z.infer<typeof CallbackAction>;
export type Callback = { action: CallbackAction; args: string[] };

/** Pure. Throws Error when the result exceeds 64 bytes or an arg contains ":". */
export function encodeCallback(cb: Callback): string {
  return notImplemented(cb);
}

/** Pure. null for anything that isn't a known action. */
export function decodeCallback(data: string | undefined): Callback | null {
  return notImplemented(data);
}

/**
 * Decode and route: attendee actions → attendee.onAttendeeCallback, admin actions → admin.onAdminCallback.
 * Unknown/old buttons → answerCallback "This button has expired".
 */
export async function handleCallback(ctx: BotContext, query: TgCallbackQuery): Promise<BotReply> {
  return notImplemented(ctx, query);
}
