/**
 * svc-bot: inline-button callback_data. Format "<action>:<arg>:<arg>…", at most 64 bytes (Telegram); uuids in
 * full (36 chars), so one uuid plus a short arg fits. Every press goes through the service layer with channel
 * "telegram" and is audited like any other change (SPEC §6c).
 */
import { z } from "zod";
import { onAdminCallback } from "./admin";
import { onAttendeeCallback } from "./attendee";
import { onLoginButton } from "./start";
import type { BotContext, BotReply, TgCallbackQuery } from "./types";

export const CallbackAction = z.enum([
  // attendee (bot/attendee)
  "spot", // spot:<spotId>               show that spot's answer
  "arrive", // arrive:<spotId>[:<leadMin>] tell me when it's close (5 / 10 min buttons pass leadMin)
  "nsub", // nsub:<spotId|all>           notices for a spot / all
  "nunsub", // nunsub:<subscriptionId|all>
  "usub", // usub:<spotId|all>           /subscribe: updates every 15 min for a spot / all
  "every", // every:<15|30>               updates every 15 or 30 min
  "need", // need:<fromSpotId>            /need: I'm here → asks where to
  "needto", // needto:<fromSpotId>:<first 8 of toSpotId>  /need: the request
  "needx", // needx:<requestId>           cancel a /need request
  // login (bot/start)
  "login", // login:<code>               confirms a browser's deep-link login
  // admin (bot/admin)
  "nudge", // nudge:<deviceId>
  "mute", // mute:<deviceId>[:<problemKind>]  mute that alert for me for 1 h (tracking untouched)
  "pause1h", // pause1h:<deviceId>      PAUSE TRACKING for 1 h (silence_until directive: the phone goes idle)
  "sil1h", // sil1h:<deviceId>           legacy button of already-sent alerts: now only a mute (all kinds), never a pause
  "kill", // kill:<deviceId>             asks "Are you sure?"
  "killok", // killok:<deviceId>         confirmed
  "resume", // resume:<deviceId>          lifts the kill of a Telegram/Traccar phone (it has no Resume button)
  "cday", // cday:<serviceId>:<YYYYMMDD> cancel a day, asks first
  "cdayok", // cdayok:<serviceId>:<YYYYMMDD>
  "nw", // nw:<step>:<value>             /notice wizard step
  "noop", // dismisses a confirm
]);
export type CallbackAction = z.infer<typeof CallbackAction>;
export type Callback = { action: CallbackAction; args: string[] };

/** Pure. Throws Error when the result exceeds 64 bytes or an arg contains ":". */
export function encodeCallback(cb: Callback): string {
  if (cb.args.some((a) => a.includes(":"))) throw new Error(`callback arg contains ":": ${cb.action}`);
  const data = [cb.action, ...cb.args].join(":");
  if (Buffer.byteLength(data) > 64) throw new Error(`callback data over 64 bytes: ${data}`);
  return data;
}

/** Pure. null for anything that isn't a known action. */
export function decodeCallback(data: string | undefined): Callback | null {
  const [action, ...args] = (data ?? "").split(":");
  const known = CallbackAction.safeParse(action);
  return known.success ? { action: known.data, args } : null;
}

/**
 * Decode and route: attendee actions → attendee.onAttendeeCallback, admin actions → admin.onAdminCallback.
 * Unknown/old buttons → answerCallback "This button has expired".
 */
export async function handleCallback(ctx: BotContext, query: TgCallbackQuery): Promise<BotReply> {
  const cb = decodeCallback(query.data);
  if (!cb) return { send: [], answerCallback: { callbackQueryId: query.id, text: "This button has expired" } };
  if (cb.action === "login") return onLoginButton(ctx, cb.args[0] ?? "", query);
  return ATTENDEE_ACTIONS.has(cb.action) ? onAttendeeCallback(ctx, cb, query) : onAdminCallback(ctx, cb, query);
}

const ATTENDEE_ACTIONS = new Set<CallbackAction>([
  "spot",
  "arrive",
  "nsub",
  "nunsub",
  "usub",
  "every",
  "need",
  "needto",
  "needx",
]);
