/**
 * svc-auth: Telegram login (SPEC §6c, copied from Travel CoOp). Two ways in, both through login_codes:
 * 1. "Log in with Telegram": startLogin → the browser opens t.me/<bot>?start=<code> → the bot calls claimLogin →
 *    the browser, polling finishLogin, gets the person and the adapter sets the session cookie.
 * 2. Messaging the bot: createMagicLink → <origin>/login/magic?code=… → a "Continue as …" page (peekLogin, so a
 *    link preview can't log anyone in) → its POST calls finishLogin.
 * login_codes rows are short-lived credentials, not domain data: creating and claiming them is not audited; the
 * login itself is (session.login).
 */
import { notImplemented } from "@eci-shuttle/shared";
import type { z } from "zod";
import type { Db } from "@/db";
import type { Person } from "@/db/types";
import type { TelegramUser } from "../catalog/people";

export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const MAGIC_LINK_TTL_MS = 15 * 60_000;

/**
 * A new unclaimed code (random, URL-safe, ≥ 20 chars; Telegram allows [A-Za-z0-9_-]{1,64} in /start) valid
 * LOGIN_CODE_TTL_MS, and its deep link https://t.me/<TELEGRAM_BOT_USERNAME>?start=<code>.
 */
export async function startLogin(db: Db, now: Date): Promise<{ code: string; deepLink: string; expiresAt: Date }> {
  return notImplemented(db, now);
}

/**
 * Bot side of `/start <code>`: upserts the person (catalog/people.upsertPersonFromTelegram) and binds the code to
 * their telegram id (claimed_at = now). Unknown code → NOT_FOUND; expired or already claimed → GONE.
 */
export async function claimLogin(
  db: Db,
  input: { code: string; user: z.input<typeof TelegramUser> },
  now: Date,
): Promise<Person> {
  return notImplemented(db, input, now);
}

/** Bot side of a direct message: a code already claimed for this person, as <PUBLIC_ORIGIN>/login/magic?code=… */
export async function createMagicLink(db: Db, personId: string, now: Date): Promise<{ url: string; expiresAt: Date }> {
  return notImplemented(db, personId, now);
}

export type LoginState = { status: "pending" } | { status: "expired" } | { status: "ready"; person: Person };

/** Read-only (GET of the magic link page, "Continue as …"): never consumes the code. Unknown = expired. */
export async function peekLogin(db: Db, code: string, now: Date): Promise<LoginState> {
  return notImplemented(db, code, now);
}

/**
 * Single use. A claimed, unexpired code → its person, and the row is deleted in the same transaction; audited
 * session.login (entity person, workspaceId null, actor = the person). Not claimed yet → pending (the browser
 * keeps polling). Unknown/expired → expired.
 */
export async function finishLogin(
  db: Db,
  code: string,
  now: Date,
): Promise<{ status: "pending" } | { status: "expired" } | { status: "ok"; person: Person }> {
  return notImplemented(db, code, now);
}
