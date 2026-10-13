/** svc-bot: /start and /login (SPEC §6c Login, as Travel CoOp). */
import { istHHMM } from "@eci-shuttle/shared";
import { resolveWorkspace } from "../auth/actor";
import { claimLogin, createMagicLink, pendingLoginStartedAt } from "../auth/codes";
import { isServiceError, type TelegramPayload } from "../kernel";
import { onShuttle } from "./attendee";
import { encodeCallback } from "./callbacks";
import type { BotContext, BotReply, TgCallbackQuery } from "./types";

const msg = (ctx: BotContext, html: string): TelegramPayload => ({
  chatId: ctx.chatId,
  html,
  kind: "reply",
  personId: ctx.person.id,
});

/** A magic login link for a person with any membership; null for everyone else. */
async function magicLink(ctx: BotContext): Promise<TelegramPayload | null> {
  if (!(await resolveWorkspace(ctx.db, ctx.person.id))) return null;
  const { url, expiresAt } = await createMagicLink(ctx.db, ctx.person.id, ctx.now);
  return msg(ctx, `Log in to admin: <a href="${url}">open admin</a>\nValid until ${istHHMM(expiresAt)}.`);
}

const EXPIRED = "That login link expired. Start again from the website.";

/**
 * `/start <code>` only asks: "Log in … in a browser? Only tap if you just pressed Log in (started HH:MM)" with a
 * [Yes, log me in] button (`login:<code>`); the code is claimed by onLoginButton, never by the bare deep link
 * (else anyone could send staff their own code and get their session). Unknown/expired/used → start again.
 * `/start` alone → welcome with the spot buttons (attendee), plus a magic login link when the person has any membership.
 */
export async function onStart(ctx: BotContext, payload: string | null): Promise<BotReply> {
  const code = payload?.trim();
  if (code) {
    const startedAt = await pendingLoginStartedAt(ctx.db, code, ctx.now);
    if (!startedAt) return { send: [msg(ctx, EXPIRED)] };
    const ask = `<b>Log in to ECI Shuttle admin in a browser?</b>\nOnly tap if you just pressed Log in on the website (started ${istHHMM(startedAt)}).`;
    const yes = { text: "Yes, log me in", callbackData: encodeCallback({ action: "login", args: [code] }) };
    return { send: [{ ...msg(ctx, ask), buttons: [[yes]] }] };
  }
  const [link, shuttle] = await Promise.all([magicLink(ctx), onShuttle(ctx, null)]);
  return { ...shuttle, send: [...(link ? [link] : []), ...shuttle.send] };
}

/** `/login`: a magic link (auth/codes.createMagicLink) for people with a membership; others are told login is for staff. */
export async function onLogin(ctx: BotContext): Promise<BotReply> {
  const link = await magicLink(ctx);
  return { send: [link ?? msg(ctx, "Login is only for the ops team. Send /shuttle for the next shuttle.")] };
}

/**
 * [Yes, log me in] (`login:<code>`): claims the code for the presser, only from their own private chat with the
 * bot, and turns the question into "You're logged in. Go back to your browser." (expired → start again).
 */
export async function onLoginButton(ctx: BotContext, code: string, q: TgCallbackQuery): Promise<BotReply> {
  const m = q.message;
  // a private chat's id is the person's: the button only counts in the presser's own chat with the bot
  if (!m || m.chat.id !== q.from.id)
    return { send: [], answerCallback: { callbackQueryId: q.id, text: "Open your own chat with the bot to log in." } };
  const done = (html: string, text?: string): BotReply => ({
    send: [],
    answerCallback: { callbackQueryId: q.id, text },
    edit: { chatId: m.chat.id, messageId: m.message_id, html, buttons: [] },
  });
  const p = ctx.person;
  try {
    await claimLogin(
      ctx.db,
      { code, user: { telegramId: p.telegramId, username: p.username, firstName: p.firstName, lastName: p.lastName } },
      ctx.now,
    );
  } catch (e) {
    if (isServiceError(e) && (e.code === "NOT_FOUND" || e.code === "GONE")) return done(EXPIRED);
    throw e;
  }
  return done("You're logged in. Go back to your browser.", "Logged in.");
}
