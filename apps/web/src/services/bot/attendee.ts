/**
 * svc-bot: attendee side (SPEC §6c For attendees). The same answer as the public page (public/status), never
 * lateness. Writes go through svc-subscriptions with auth/actor.attendeeActor.
 */
import type { AnswerLine, PublicNotice, PublicSpot, PublicStatus } from "@eci-shuttle/shared";
import { spots } from "@/db/schema";
import { attendeeActor } from "../auth/actor";
import { findInWorkspace, isServiceError, type TelegramButton, userMessage } from "../kernel";
import { publicStatus } from "../public/status";
import { DEFAULT_LEAD_MIN, subscribeArrival, subscribeNotices, unsubscribe } from "../subscriptions/subscriptions";
import { type Callback, type CallbackAction, encodeCallback } from "./callbacks";
import type { BotContext, BotReply, TgCallbackQuery } from "./types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const btn = (text: string, action: CallbackAction, ...args: string[]): TelegramButton => ({
  text,
  callbackData: encodeCallback({ action, args }),
});

const say = (ctx: BotContext, html: string, buttons?: TelegramButton[][]): BotReply => ({
  send: [{ chatId: ctx.chatId, html, kind: "reply", ...(buttons?.length ? { buttons } : {}) }],
});

/** Spot buttons, three to a row. */
function spotButtons(list: PublicSpot[]): TelegramButton[][] {
  const rows: TelegramButton[][] = [];
  for (let i = 0; i < list.length; i += 3)
    rows.push(list.slice(i, i + 3).map((s) => btn(s.shortName, "spot", s.spotId)));
  return rows;
}

const status = (ctx: BotContext) => publicStatus(ctx.db, ctx.workspace.id, ctx.now);

/** The answer for one spot: lines, its notices, then alert / notices buttons and the other spots. */
function spotReply(ctx: BotContext, st: PublicStatus, spot: PublicSpot): BotReply {
  const seen = new Map<string, PublicNotice>();
  for (const n of [...st.notices, ...spot.notices, ...spot.answers.flatMap((l) => l.notices)]) seen.set(n.id, n);
  const notices = [...seen.values()].map((n) => `${n.severity === "urgent" ? "<b>Urgent:</b> " : ""}${esc(n.text)}`);
  const html = renderAnswer(spot.name, spot.answers) + (notices.length ? `\n\n${notices.join("\n")}` : "");
  return say(ctx, html, [
    [
      btn(`Tell me when ${DEFAULT_LEAD_MIN} min away`, "arrive", spot.spotId, String(DEFAULT_LEAD_MIN)),
      btn("10 min away", "arrive", spot.spotId, "10"),
    ],
    [btn(`Notices for ${spot.shortName}`, "nsub", spot.spotId)],
    ...spotButtons(st.spots.filter((s) => s.spotId !== spot.spotId)),
  ]);
}

/** `/shuttle [spot]`: the spot buttons (spots with a public service today), or that spot's answer. */
export async function onShuttle(ctx: BotContext, arg: string | null): Promise<BotReply> {
  const st = await status(ctx);
  const q = arg?.trim().toLowerCase();
  const spot = q ? st.spots.find((s) => s.shortName.toLowerCase() === q || s.name.toLowerCase() === q) : undefined;
  if (spot) return spotReply(ctx, st, spot);
  if (st.spots.length === 0) return say(ctx, "No shuttles are running today.");
  return say(
    ctx,
    q ? `I don't know a stop called "${esc(arg?.trim() ?? "")}". Where are you?` : "Where are you?",
    spotButtons(st.spots),
  );
}

/**
 * A spot's answer (public/status.spotAnswer) rendered with renderAnswer, with buttons:
 * [Tell me when it's close] [Notices for <spot>] and the other spots.
 */
export async function onSpot(ctx: BotContext, spotId: string): Promise<BotReply> {
  // publicStatus rather than spotAnswer: same answer lines, plus names, notices and the other spots in one read
  const st = await status(ctx);
  const spot = st.spots.find((s) => s.spotId === spotId);
  if (spot) return spotReply(ctx, st, spot);
  return say(ctx, "No shuttle stops there today.", spotButtons(st.spots));
}

function lineText(l: AnswerLine): string {
  if (l.kind === "live" && l.minutes != null) {
    if (l.minutes === 0) return "<b>here now</b> · live";
    const range =
      l.rangeLo != null && l.rangeHi != null && l.rangeLo !== l.rangeHi ? ` (${l.rangeLo}–${l.rangeHi})` : "";
    return `here in <b>${l.approx ? "about " : ""}${l.minutes} min</b>${range} · live`;
  }
  if (l.kind === "timetable" && l.nextAtLabel) return `next scheduled ${l.nextAtLabel} · ${esc(l.phaseText)}`;
  return esc(l.phaseText);
}

/**
 * Pure. Telegram HTML for one spot, one line per service, like the page:
 * "<b>Riva</b>\nTo Circle: here in <b>6 min</b> (5–9) · live\nParty shuttle: next scheduled 22:00 · live tracking off".
 * Escapes names. Never says late/behind.
 */
export function renderAnswer(spotName: string, lines: AnswerLine[]): string {
  const body = lines.length
    ? lines.map((l) => `${esc(l.serviceName)}: ${lineText(l)}`)
    : ["No shuttles from here today."];
  return [`<b>${esc(spotName)}</b>`, ...body].join("\n");
}

/** `/stop`: cancel all of the person's subscriptions (subscriptions.unsubscribe "all"). */
export async function onStop(ctx: BotContext): Promise<BotReply> {
  const actor = attendeeActor(ctx.person, ctx.workspace.id);
  const n = await unsubscribe(ctx.db, actor, { workspaceId: ctx.workspace.id, subscriptionId: "all" }, ctx.now);
  return say(ctx, n ? "Done. I've turned off your alerts and notices." : "You had nothing turned on. Nothing to stop.");
}

/** Buttons spot / arrive / nsub / nunsub. */
export async function onAttendeeCallback(ctx: BotContext, cb: Callback, query: TgCallbackQuery): Promise<BotReply> {
  const ack = (text?: string, showAlert?: boolean) => ({
    callbackQueryId: query.id,
    ...(text ? { text } : {}),
    ...(showAlert ? { showAlert } : {}),
  });
  const actor = attendeeActor(ctx.person, ctx.workspace.id);
  const workspaceId = ctx.workspace.id;
  const spotName = async (id: string) => (await findInWorkspace(ctx.db, spots, workspaceId, id))?.name ?? "that stop";
  const [arg, arg2] = cb.args;

  try {
    switch (cb.action) {
      case "spot":
        return { ...(await onSpot(ctx, arg)), answerCallback: ack() };
      case "arrive": {
        const leadMin = Number(arg2) || DEFAULT_LEAD_MIN;
        const sub = await subscribeArrival(ctx.db, actor, { workspaceId, spotId: arg, leadMin }, ctx.now);
        return {
          ...say(
            ctx,
            `OK. I'll message you when a shuttle is ${leadMin} min from <b>${esc(await spotName(arg))}</b>. This alert ends after 2 h.`,
            [[btn("Cancel this alert", "nunsub", sub.id)]],
          ),
          answerCallback: ack("Alert set"),
        };
      }
      case "nsub": {
        const spotId = arg === "all" ? null : arg;
        const sub = await subscribeNotices(ctx.db, actor, { workspaceId, spotId }, ctx.now);
        const where = spotId ? `<b>${esc(await spotName(spotId))}</b>` : "every stop";
        return {
          ...say(ctx, `You'll get notices for ${where}. Send /stop to turn everything off.`, [
            [btn("Stop these notices", "nunsub", sub.id)],
            ...(spotId ? [[btn("Notices for every stop", "nsub", "all")]] : []),
          ]),
          answerCallback: ack("Subscribed"),
        };
      }
      case "nunsub": {
        const n = await unsubscribe(ctx.db, actor, { workspaceId, subscriptionId: arg }, ctx.now);
        return { send: [], answerCallback: ack(n ? "Turned off." : "That was already off.") };
      }
      default:
        return { send: [], answerCallback: ack("This button has expired") };
    }
  } catch (e) {
    if (isServiceError(e)) return { send: [], answerCallback: ack(userMessage(e), true) };
    throw e;
  }
}
