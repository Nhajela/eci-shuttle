/**
 * svc-bot: talking to the Telegram Bot API. The only code that calls api.telegram.org. Every send is logged in
 * telegram_messages (ok, message_id, error), as in Travel CoOp. `fetchImpl` is injectable: tests never call
 * Telegram. In tests and dev without TELEGRAM_BOT_TOKEN nothing is sent: the message is only logged (dev outbox).
 * In production a missing token is a permanent failure, never a fake send.
 * Pacing (≤ 25/s, ≤ 1/s per chat) is the worker queue job's; this module reports 429 retry_after back to it.
 */
import type { Db } from "@/db";
import { telegramMessages } from "@/db/schema";
import { env } from "@/lib/env";
import { markBlockedBot } from "../catalog/people";
import { type DeliveryResult, type OutboxJob, systemActor, type TelegramButton, type TelegramPayload } from "../kernel";
import { recordGroupPost } from "../notices/notices";
import type { BotReply } from "./types";

/** A Bot API error: `code` is Telegram's error_code (or the HTTP status), `retryAfterS` its 429 retry_after. */
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    description: string,
    readonly retryAfterS?: number,
  ) {
    super(`Telegram ${code}: ${description}`);
  }
}

type TgResponse = {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

/** POST https://api.telegram.org/bot<token>/<method>; returns Telegram's `result` or throws with its error_code. */
export async function callTelegram<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`https://api.telegram.org/bot${env.telegramBotToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = (await res.json().catch(() => null)) as TgResponse | null;
  if (body?.ok) return body.result as T;
  throw new TelegramError(
    body?.error_code ?? res.status,
    body?.description ?? `HTTP ${res.status}`,
    body?.parameters?.retry_after,
  );
}

const keyboard = (rows?: TelegramButton[][]) =>
  rows && {
    inline_keyboard: rows.map((r) =>
      r.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData })),
    ),
  };

const NO_TOKEN = "no TELEGRAM_BOT_TOKEN";
// process.env, not env.telegramBotToken(): that throws when the token is missing
const noToken = () => !process.env.TELEGRAM_BOT_TOKEN;
const dev = () => noToken() && process.env.NODE_ENV !== "production";
const BOT = systemActor("bot-deliver");

function failure(e: unknown): DeliveryResult {
  if (noToken()) return { ok: false, retry: false, error: NO_TOKEN };
  const error = e instanceof Error ? e.message : String(e);
  if (!(e instanceof TelegramError)) return { ok: false, retry: true, error }; // network
  if (e.code === 429) return { ok: false, retry: true, error, retryAfterMs: (e.retryAfterS ?? 1) * 1_000 };
  return e.code >= 500 ? { ok: false, retry: true, error } : { ok: false, retry: false, error };
}

async function send(
  db: Db,
  p: TelegramPayload,
  fetchImpl: typeof fetch,
  workspaceId: string | null,
): Promise<DeliveryResult> {
  if (p.unpinMessageId !== undefined) {
    if (dev()) return { ok: true };
    try {
      await callTelegram("unpinChatMessage", { chat_id: p.chatId, message_id: p.unpinMessageId }, fetchImpl);
      return { ok: true };
    } catch (e) {
      return failure(e);
    }
  }

  let messageId: number | null = null;
  let err: unknown = null;
  if (!dev()) {
    try {
      if (noToken()) throw new Error(NO_TOKEN);
      const m = await callTelegram<{ message_id: number }>(
        "sendMessage",
        {
          chat_id: p.chatId,
          text: p.html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard(p.buttons),
        },
        fetchImpl,
      );
      messageId = m.message_id;
    } catch (e) {
      err = e;
    }
  }
  // the message log is bookkeeping, not audited (like outbox status)
  await db.insert(telegramMessages).values({
    workspaceId,
    chatId: p.chatId,
    kind: p.kind,
    text: p.html,
    ok: !err,
    messageId,
    error: err ? (err instanceof Error ? err.message : String(err)) : null,
  });

  if (err) {
    if (err instanceof TelegramError && err.code === 403 && p.personId) {
      await markBlockedBot(db, BOT, { personId: p.personId, at: new Date() });
    }
    return failure(err);
  }
  if (messageId === null) return { ok: true };
  // the message is out: a failure from here on must not make the queue send it twice
  try {
    if (p.pin) await callTelegram("pinChatMessage", { chat_id: p.chatId, message_id: messageId }, fetchImpl);
    if (p.ref?.kind === "notice_group_post") await recordGroupPost(db, p.ref.noticeId, messageId);
  } catch (e) {
    console.error(`telegram: after sending message ${messageId} to ${p.chatId}:`, e);
  }
  return { ok: true };
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
  return send(db, payload, fetchImpl, null);
}

/** The worker queue job's deliverer for outbox kind "telegram": sendNow(job.payload), logged with the job's workspace. */
export async function deliverTelegram(
  db: Db,
  job: OutboxJob,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  return send(db, job.payload as TelegramPayload, fetchImpl, job.workspaceId);
}

/** The webhook adapter's way to perform a BotReply: answerCallbackQuery, editMessageText, then each send. */
export async function performReply(db: Db, reply: BotReply, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!dev()) {
    // best effort: an old callback query or "message is not modified" must not stop the sends below
    const tryCall = (method: string, params: Record<string, unknown>) =>
      callTelegram(method, params, fetchImpl).catch((e) => console.error(`telegram ${method}:`, e));
    const a = reply.answerCallback;
    if (a)
      await tryCall("answerCallbackQuery", {
        callback_query_id: a.callbackQueryId,
        text: a.text,
        show_alert: a.showAlert,
      });
    const ed = reply.edit;
    if (ed) {
      await tryCall("editMessageText", {
        chat_id: ed.chatId,
        message_id: ed.messageId,
        text: ed.html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard(ed.buttons),
      });
    }
  }
  for (const p of reply.send) await send(db, p, fetchImpl, null);
}
