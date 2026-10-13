/** svc-bot: the webhook entry. app/api/telegram/route.ts checks the secret header, then calls handleUpdate. */
import type { Db } from "@/db";
import { markBlockedBot, upsertPersonFromTelegram } from "../catalog/people";
import { isSpotName } from "../catalog/spots";
import { listAllWorkspaces, workspaceBySlug } from "../catalog/workspaces";
import { isServiceError, systemActor, userMessage } from "../kernel";
import { onNotice, onSetGroup, onSilence, onStatus, onToday } from "./admin";
import { onShuttle, onStop } from "./attendee";
import { handleCallback } from "./callbacks";
import { onLogin, onStart } from "./start";
import type { BotContext, BotReply, TgUpdate } from "./types";

const BOT = systemActor("bot", "telegram");
const NONE: BotReply = { send: [] };
const HELP =
  "Send /shuttle to see when the next shuttle comes, or just type your stop's name (e.g. riva).\n" +
  "/stop turns off your alerts and notices.";
const say = (chatId: number, html: string): BotReply => ({ send: [{ chatId, html, kind: "reply" }] });

/**
 * Route one update (never throws for a person's mistake: a ServiceError becomes a reply with userMessage(e), or an alert on a button press):
 * - every update: upsert the sender (catalog/people.upsertPersonFromTelegram, startedBot in private chats).
 * - my_chat_member kicked in a private chat → catalog/people.markBlockedBot; empty reply.
 * - "/start <payload>" → start.onStart; "/login" → start.onLogin.
 * - "/shuttle" or a spot's short name / name typed alone ("riva", case-insensitive) → attendee handlers.
 * - "/status", "/today", "/notice", "/silence", "/setgroup" → admin handlers (need a membership; otherwise a polite no).
 * - "/stop" → attendee.onStop.
 * - callback_query → callbacks.handleCallback.
 * - anything else in a private chat → a short help text; in groups → nothing.
 * No live workspace → "The shuttle isn't set up yet."
 */
export async function handleUpdate(db: Db, update: TgUpdate, now: Date): Promise<BotReply> {
  const { message, callback_query: query, my_chat_member: member } = update;
  const from = query?.from ?? message?.from ?? member?.from;
  const chat = query?.message?.chat ?? message?.chat ?? member?.chat;
  if (!from || from.is_bot) return NONE;
  const isPrivate = chat?.type === "private";
  const kicked = member?.new_chat_member.status === "kicked";

  const person = await upsertPersonFromTelegram(db, BOT, {
    telegramId: from.id,
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
    startedBot: isPrivate && !kicked,
  });
  if (member) {
    if (kicked && isPrivate) await markBlockedBot(db, BOT, { personId: person.id, at: now });
    return NONE;
  }

  const chatId = chat?.id ?? from.id; // a button on an inline-mode message has no chat: answer the presser
  const text = message?.text?.trim();
  if (!query && !text) return NONE;
  // "/status@eci_shuttle_bot test" → command "status", rest "test"
  const m = text ? /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text) : null;
  const command = m?.[1].toLowerCase() ?? null;
  const rest = m?.[2]?.trim() || null;

  // login needs no shuttle: let staff log in before a workspace is made live
  const loginOnly = command === "start" || command === "login" || !!query?.data?.startsWith("login:");
  const workspace =
    (await workspaceBySlug(db, null)) ?? (loginOnly ? ((await listAllWorkspaces(db))[0] ?? null) : null);
  if (!workspace) {
    if (query)
      return { send: [], answerCallback: { callbackQueryId: query.id, text: "The shuttle isn't set up yet." } };
    return isPrivate || command ? say(chatId, "The shuttle isn't set up yet.") : NONE;
  }
  const ctx: BotContext = { db, now, person, chatId, workspace };

  try {
    if (query) return await handleCallback(ctx, query);
    const args = rest?.split(/\s+/) ?? [];
    switch (command) {
      case "start":
        return await onStart(ctx, rest);
      case "login":
        return await onLogin(ctx);
      case "shuttle":
        return await onShuttle(ctx, rest);
      case "status":
        return await onStatus(ctx, args);
      case "today":
        return await onToday(ctx, args);
      case "silence":
        return await onSilence(ctx, args);
      case "setgroup":
        return await onSetGroup(ctx, args, chat?.type === "group" || chat?.type === "supergroup");
      case "notice":
        return await onNotice(ctx, text ?? "");
      case "stop":
        return await onStop(ctx);
      case null:
        // ponytail: one indexed lookup per short message, groups included; cache spot names if groups get busy
        if (text && text.length <= 60 && (await isSpotName(db, workspace.id, text))) return await onShuttle(ctx, text);
    }
    return isPrivate ? say(chatId, HELP) : NONE;
  } catch (e) {
    if (!isServiceError(e)) throw e;
    // a refused press stops the spinner as an alert, not a chat message the whole group would see
    if (query)
      return { send: [], answerCallback: { callbackQueryId: query.id, text: userMessage(e), showAlert: true } };
    return say(chatId, userMessage(e));
  }
}
