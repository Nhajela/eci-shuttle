/**
 * svc-bot: talking to the Telegram Bot API. The only code that calls api.telegram.org. Every send is logged in
 * telegram_messages (ok, message_id, error), as in Travel CoOp. `fetchImpl` is injectable: tests never call
 * Telegram. In tests and dev without TELEGRAM_BOT_TOKEN nothing is sent: the message is only logged (dev outbox).
 */
import { notImplemented } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import type { DeliveryResult, OutboxJob, TelegramPayload } from "../kernel";
import type { BotReply } from "./types";

/** POST https://api.telegram.org/bot<token>/<method>; returns Telegram's `result` or throws with its error_code. */
export async function callTelegram<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  return notImplemented(method, params, fetchImpl);
}

/**
 * One payload: sendMessage (parse_mode HTML, inline_keyboard from buttons, no link previews), then
 * pinChatMessage when pin; or unpinChatMessage when unpinMessageId. 403 (blocked / kicked) → markBlockedBot
 * for payload.personId and retry false; 429 → retry true (after retry_after); 5xx/network → retry true; other 4xx
 * → retry false. After a successful send with ref notice_group_post → notices.recordGroupPost.
 */
export async function sendNow(
  db: Db,
  payload: TelegramPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  return notImplemented(db, payload, fetchImpl);
}

/** The worker queue job's deliverer for outbox kind "telegram": sendNow(job.payload). */
export async function deliverTelegram(
  db: Db,
  job: OutboxJob,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  return notImplemented(db, job, fetchImpl);
}

/** The webhook adapter's way to perform a BotReply: answerCallbackQuery, editMessageText, then each send. */
export async function performReply(db: Db, reply: BotReply, fetchImpl: typeof fetch = fetch): Promise<void> {
  return notImplemented(db, reply, fetchImpl);
}
