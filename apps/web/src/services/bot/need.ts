/**
 * svc-bot: `/need` (SPEC §6c For attendees) — "I need a shuttle": Where are you? → Where to? → Got it. In a private
 * chat only (handle.ts). Writes go through subscriptions/need.requestPickup with the attendee actor; cancelling
 * through subscriptions.unsubscribe. Only stops with a public service running now are offered.
 */
import type { PublicSpot } from "@eci-shuttle/shared";
import { spots } from "@/db/schema";
import { escapeHtml as esc } from "@/lib/telegram/html";
import { attendeeActor } from "../auth/actor";
import { findInWorkspace, type TelegramButton } from "../kernel";
import { publicStatus } from "../public/status";
import { requestPickup } from "../subscriptions/need";
import { matchNeed, needSpots, notRunningText } from "../subscriptions/need-text";
import { unsubscribe } from "../subscriptions/subscriptions";
import { type Callback, type CallbackAction, encodeCallback } from "./callbacks";
import type { BotContext, BotReply } from "./types";

/** "needto:<fromId>:<first 8 of toId>": two full uuids don't fit Telegram's 64 bytes */
const TO_PREFIX = 8;

const btn = (text: string, action: CallbackAction, ...args: string[]): TelegramButton => ({
  text,
  callbackData: encodeCallback({ action, args }),
});
const say = (ctx: BotContext, html: string, buttons?: TelegramButton[][]): BotReply => ({
  send: [{ chatId: ctx.chatId, html, kind: "reply", ...(buttons?.length ? { buttons } : {}) }],
});
const rows = (list: TelegramButton[]) => {
  const out: TelegramButton[][] = [];
  for (let i = 0; i < list.length; i += 3) out.push(list.slice(i, i + 3));
  return out;
};

const runningNow = async (ctx: BotContext) => needSpots(await publicStatus(ctx.db, ctx.workspace.id, ctx.now));
const whereAreYou = (ctx: BotContext, html: string, live: PublicSpot[]) =>
  say(ctx, html, rows(live.map((s) => btn(s.shortName, "need", s.spotId))));

function whereTo(ctx: BotContext, from: PublicSpot, live: PublicSpot[]): BotReply {
  const others = live.filter((s) => s.spotId !== from.spotId);
  if (!others.length) return say(ctx, "Hmm, no other stop has a shuttle right now. 😴");
  return say(
    ctx,
    `From <b>${esc(from.shortName)}</b> — where to?`,
    rows(others.map((s) => btn(s.shortName, "needto", from.spotId, s.spotId.slice(0, TO_PREFIX)))),
  );
}

async function requested(ctx: BotContext, fromSpotId: string, toSpotId: string): Promise<BotReply> {
  const actor = attendeeActor(ctx.person, ctx.workspace.id);
  const { request, replaced } = await requestPickup(
    ctx.db,
    actor,
    { workspaceId: ctx.workspace.id, fromSpotId, toSpotId },
    ctx.now,
  );
  const name = async (id: string) => (await findInWorkspace(ctx.db, spots, ctx.workspace.id, id))?.shortName ?? "";
  const html =
    `🙌 Got it: a shuttle from ${esc(await name(fromSpotId))} to ${esc(await name(toSpotId))}. The shuttle team knows. ` +
    "I'll message you the moment it's here." +
    (replaced ? " This replaces your earlier request." : "");
  return say(ctx, html, [[btn("Cancel request", "needx", request.id)]]);
}

/** `/need [from [to]]`: ask where they are (and where to), or make the request in one go. */
export async function onNeed(ctx: BotContext, arg: string | null): Promise<BotReply> {
  const { spots: live, nextStart } = await runningNow(ctx);
  if (!live.length) return say(ctx, notRunningText(nextStart));
  if (!arg?.trim()) return whereAreYou(ctx, "🙋 Where are you?", live);
  const m = matchNeed(arg, live);
  if ("unknown" in m)
    return whereAreYou(
      ctx,
      `I don't know a stop called "${esc(m.unknown)}" with a shuttle right now. Where are you?`,
      live,
    );
  return m.to ? requested(ctx, m.from.spotId, m.to.spotId) : whereTo(ctx, m.from, live);
}

/**
 * Buttons need:<fromId> (→ Where to?), needto:<fromId>:<toId prefix> (→ the request), needx:<requestId> (cancel).
 * ServiceErrors propagate: attendee.onAttendeeCallback shows them as an alert.
 */
export async function onNeedButton(ctx: BotContext, cb: Callback): Promise<BotReply | "expired"> {
  const [arg, arg2] = cb.args;
  if (cb.action === "needx") {
    const actor = attendeeActor(ctx.person, ctx.workspace.id);
    const n = await unsubscribe(ctx.db, actor, { workspaceId: ctx.workspace.id, subscriptionId: arg ?? "" }, ctx.now);
    return say(
      ctx,
      n
        ? "👍 Cancelled your shuttle request. Send /need any time you need one again."
        : "That request was already closed.",
    );
  }
  const { spots: live, nextStart } = await runningNow(ctx);
  if (!live.length) return say(ctx, notRunningText(nextStart));
  if (cb.action === "need") {
    const from = live.find((s) => s.spotId === arg);
    return from ? whereTo(ctx, from, live) : whereAreYou(ctx, "No shuttle stops there right now. Where are you?", live);
  }
  const to = arg2 ? live.filter((s) => s.spotId !== arg && s.spotId.startsWith(arg2)) : [];
  if (!arg || to.length !== 1) return "expired";
  return requested(ctx, arg, (to[0] as PublicSpot).spotId);
}
