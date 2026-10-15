/** svc-bot: the webhook entry. app/api/telegram/route.ts checks the secret header, then calls handleUpdate. */
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { spots } from "@/db/schema";
import type { Workspace } from "@/db/types";
import { markBlockedBot, membershipsOf, upsertPersonFromTelegram } from "../catalog/people";
import { isSpotName } from "../catalog/spots";
import { listAllWorkspaces, workspaceBySlug } from "../catalog/workspaces";
import { isServiceError, systemActor, userMessage } from "../kernel";
import { onInvite, onNotice, onSetGroup, onSilence, onStatus, onToday } from "./admin";
import { onShuttle, onStop, onSubscribe, onUnsubscribe } from "./attendee";
import { handleCallback } from "./callbacks";
import { onLocation, onPair } from "./live";
import { onNeed } from "./need";
import { onLogin, onStart } from "./start";
import type { BotContext, BotReply, TgUpdate } from "./types";

const BOT = systemActor("bot", "telegram");
const NONE: BotReply = { send: [] };
const HELP =
  "Send /shuttle to see when the next shuttle comes, or just type your stop's name (e.g. riva).\n" +
  "/subscribe sends you where the shuttle is every 15 min; /unsubscribe stops it.\n" +
  "/need tells the shuttle team you're waiting for a shuttle, and I'll tell you when it's here.\n" +
  "/stop (or just stop) turns off your alerts, updates, notices and shuttle request.\n" +
  "Driver without the shuttle app? Send /pair and the 6-digit code from the shuttle team, then share your live location here.";
const say = (chatId: number, html: string): BotReply => ({ send: [{ chatId, html, kind: "reply" }] });

/**
 * Route one update (never throws for a person's mistake: a ServiceError becomes a reply with userMessage(e), or an alert on a button press):
 * - every update: upsert the sender (catalog/people.upsertPersonFromTelegram, startedBot in private chats).
 * - my_chat_member kicked in a private chat → catalog/people.markBlockedBot; empty reply.
 * - "/start <payload>" → start.onStart; "/login" → start.onLogin.
 * - "/shuttle" or a spot's short name / name typed alone ("riva", case-insensitive) → attendee handlers.
 * - "/status", "/today", "/notice", "/silence", "/setgroup" → admin handlers (need a membership; otherwise a polite no).
 * - "/stop" → attendee.onStop. "/pair <code>" in a private chat → live.onPair.
 * - "stop" / "unsubscribe" typed without the slash in a private chat → onStop / onUnsubscribe (the welcome says so).
 * - a location message or any edited_message → live.onLocation (first, without the person upsert).
 * - callback_query → callbacks.handleCallback.
 * - anything else in a private chat → a short help text; in groups → nothing.
 * No live workspace → "The shuttle isn't set up yet."
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A spot button ("spot:<spotId>", "arrive:…", "nsub:…") whose spot is in a workspace this person is a member of. */
async function buttonWorkspace(db: Db, personId: string, data: string | undefined): Promise<Workspace | null> {
  const [action, spotId] = (data ?? "").split(":");
  if (!["spot", "arrive", "nsub", "nunsub", "need", "needto"].includes(action) || !spotId || !UUID.test(spotId))
    return null;
  const [spot] = await db.select({ workspaceId: spots.workspaceId }).from(spots).where(eq(spots.id, spotId));
  if (!spot) return null;
  const mine = await membershipsOf(db, personId);
  if (!mine.some((m) => m.workspaceId === spot.workspaceId)) return null;
  return (await listAllWorkspaces(db)).find((w) => w.id === spot.workspaceId) ?? null;
}

/** The last word of the text, when it is the slug of a workspace this person is a member of. */
async function memberWorkspace(
  db: Db,
  personId: string,
  text: string | undefined,
): Promise<{ workspace: Workspace; rest: string | null } | null> {
  const words = (text ?? "")
    .replace(/^\/\w+(?:@\w+)?/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const slug = words.at(-1)?.toLowerCase();
  if (!slug) return null;
  const mine = await membershipsOf(db, personId);
  if (!mine.length) return null;
  const ws = await workspaceBySlug(db, slug);
  if (!ws || !mine.some((m) => m.workspaceId === ws.id)) return null;
  return { workspace: ws, rest: words.slice(0, -1).join(" ") || null };
}

export async function handleUpdate(db: Db, update: TgUpdate, now: Date): Promise<BotReply> {
  const { message, callback_query: query, my_chat_member: member } = update;
  // live-location pings (every few seconds per driver): before the person upsert, which they don't need
  const located = update.edited_message ?? (message?.location ? message : undefined);
  if (located) return located.from?.is_bot ? NONE : await onLocation(db, located, now);
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

  // login and pairing need no shuttle: let staff log in and drivers pair before a workspace is made live
  const loginOnly =
    command === "start" || command === "login" || command === "pair" || !!query?.data?.startsWith("login:");
  const workspace =
    (await workspaceBySlug(db, null)) ?? (loginOnly ? ((await listAllWorkspaces(db))[0] ?? null) : null);
  if (!workspace) {
    if (query)
      return { send: [], answerCallback: { callbackQueryId: query.id, text: "The shuttle isn't set up yet." } };
    return isPrivate || command ? say(chatId, "The shuttle isn't set up yet.") : NONE;
  }
  // staff can ask about another workspace they belong to by naming its slug last: "/shuttle test", "riva test"
  const asked =
    !query && (command === "shuttle" || command === "need" || command === null)
      ? await memberWorkspace(db, person.id, text)
      : null;
  const pressedIn = query ? await buttonWorkspace(db, person.id, query.data) : null;
  const ctx: BotContext = { db, now, person, chatId, workspace: asked?.workspace ?? pressedIn ?? workspace };
  const shuttleArg = asked ? asked.rest : rest;

  try {
    if (query) return await handleCallback(ctx, query);
    const args = rest?.split(/\s+/) ?? [];
    if (asked && command === null) {
      if (asked.rest && (await isSpotName(db, asked.workspace.id, asked.rest))) return await onShuttle(ctx, asked.rest);
      return isPrivate ? say(chatId, HELP) : NONE;
    }
    switch (command) {
      case "start":
        return await onStart(ctx, rest);
      case "login":
        return await onLogin(ctx);
      case "shuttle":
        return await onShuttle(ctx, shuttleArg);
      case "status":
        return await onStatus(ctx, args);
      case "today":
        return await onToday(ctx, args);
      case "silence":
        return await onSilence(ctx, args);
      case "invite":
        return await onInvite(ctx, args);
      case "setgroup":
        return await onSetGroup(ctx, args, chat?.type === "group" || chat?.type === "supergroup");
      case "notice":
        return await onNotice(ctx, text ?? "");
      case "need":
        // the "here" message comes by private message, which needs the person to have started the bot
        return isPrivate ? await onNeed(ctx, shuttleArg) : say(chatId, "Send /need to me in a private chat.");
      case "subscribe":
        // updates come by private message, which needs the person to have started the bot
        return isPrivate ? await onSubscribe(ctx, rest) : say(chatId, "Send /subscribe to me in a private chat.");
      case "unsubscribe":
        return await onUnsubscribe(ctx);
      case "stop":
        return await onStop(ctx);
      case "pair":
        // the code is a credential: never take it from a group
        return isPrivate ? await onPair(ctx, rest) : NONE;
      case null: {
        // the welcome tells people to "just send 'stop' or 'unsubscribe'": take the bare words, only in private
        const word = isPrivate ? text?.toLowerCase().replace(/[^a-z]/g, "") : null;
        if (word === "stop") return await onStop(ctx);
        if (word === "unsubscribe") return await onUnsubscribe(ctx);
        // ponytail: one indexed lookup per short message, groups included; cache spot names if groups get busy
        if (text && text.length <= 60 && (await isSpotName(db, workspace.id, text))) return await onShuttle(ctx, text);
      }
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
