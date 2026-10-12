/** svc-bot: /start and /login (SPEC §6c Login, as Travel CoOp). */
import { notImplemented } from "@eci-shuttle/shared";
import type { BotContext, BotReply } from "./types";

/**
 * `/start <code>` → auth/codes.claimLogin → "You're logged in. Go back to your browser." (expired → "That login
 * link expired, start again from the website"). `/start` alone → welcome with the spot buttons (attendee), plus
 * a magic login link (onLogin) when the person has any membership.
 */
export async function onStart(ctx: BotContext, payload: string | null): Promise<BotReply> {
  return notImplemented(ctx, payload);
}

/** `/login`: a magic link (auth/codes.createMagicLink) for people with a membership; others are told login is for staff. */
export async function onLogin(ctx: BotContext): Promise<BotReply> {
  return notImplemented(ctx);
}
