/** svc-bot: /start and /login (SPEC §6c Login, as Travel CoOp). */
import { istHHMM } from "@eci-shuttle/shared";
import { resolveWorkspace } from "../auth/actor";
import { claimLogin, createMagicLink } from "../auth/codes";
import { isServiceError, type TelegramPayload } from "../kernel";
import { onShuttle } from "./attendee";
import type { BotContext, BotReply } from "./types";

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

/**
 * `/start <code>` → auth/codes.claimLogin → "You're logged in. Go back to your browser." (expired → "That login
 * link expired, start again from the website"). `/start` alone → welcome with the spot buttons (attendee), plus
 * a magic login link (onLogin) when the person has any membership.
 */
export async function onStart(ctx: BotContext, payload: string | null): Promise<BotReply> {
  const code = payload?.trim();
  if (code) {
    const p = ctx.person;
    try {
      await claimLogin(
        ctx.db,
        {
          code,
          user: { telegramId: p.telegramId, username: p.username, firstName: p.firstName, lastName: p.lastName },
        },
        ctx.now,
      );
    } catch (e) {
      if (isServiceError(e) && (e.code === "NOT_FOUND" || e.code === "GONE"))
        return { send: [msg(ctx, "That login link expired. Start again from the website.")] };
      throw e;
    }
    return { send: [msg(ctx, "You're logged in. Go back to your browser.")] };
  }
  const [link, shuttle] = await Promise.all([magicLink(ctx), onShuttle(ctx, null)]);
  return { ...shuttle, send: [...(link ? [link] : []), ...shuttle.send] };
}

/** `/login`: a magic link (auth/codes.createMagicLink) for people with a membership; others are told login is for staff. */
export async function onLogin(ctx: BotContext): Promise<BotReply> {
  const link = await magicLink(ctx);
  return { send: [link ?? msg(ctx, "Login is only for the ops team. Send /shuttle for the next shuttle.")] };
}
