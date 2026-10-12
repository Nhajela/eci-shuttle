/** svc-bot: the webhook entry. app/api/telegram/route.ts checks the secret header, then calls handleUpdate. */
import { notImplemented } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import type { BotReply, TgUpdate } from "./types";

/**
 * Route one update (never throws for a person's mistake: a ServiceError becomes a reply with userMessage(e)):
 * - every update: upsert the sender (catalog/people.upsertPersonFromTelegram, startedBot in private chats).
 * - my_chat_member kicked in a private chat → catalog/people.markBlockedBot; empty reply.
 * - "/start <payload>" → start.onStart; "/login" → start.onLogin.
 * - "/shuttle" or a spot's short name / name typed alone ("riva", case-insensitive) → attendee handlers.
 * - "/status", "/today", "/notice", "/silence" → admin handlers (need a membership; otherwise a polite no).
 * - "/stop" → attendee.onStop.
 * - callback_query → callbacks.handleCallback.
 * - anything else in a private chat → a short help text; in groups → nothing.
 * No live workspace → "The shuttle isn't set up yet."
 */
export async function handleUpdate(db: Db, update: TgUpdate, now: Date): Promise<BotReply> {
  return notImplemented(db, update, now);
}
