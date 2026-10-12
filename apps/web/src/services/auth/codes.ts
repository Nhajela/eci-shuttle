/**
 * svc-auth: Telegram login (SPEC §6c, copied from Travel CoOp). Two ways in, both through login_codes:
 * 1. "Log in with Telegram": startLogin → the browser opens t.me/<bot>?start=<code> → the bot calls claimLogin →
 *    the browser, polling finishLogin, gets the person and the adapter sets the session cookie.
 * 2. Messaging the bot: createMagicLink → <origin>/login/magic?code=… → a "Continue as …" page (peekLogin, so a
 *    link preview can't log anyone in) → its POST calls finishLogin.
 * login_codes rows are short-lived credentials, not domain data: creating and claiming them is not audited; the
 * login itself is (session.login).
 */
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { loginCodes, people } from "@/db/schema";
import type { LoginCode, Person } from "@/db/types";
import { env, origin } from "@/lib/env";
import { type TelegramUser, upsertPersonFromTelegram } from "../catalog/people";
import { mutate, ServiceError, systemActor } from "../kernel";

export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const MAGIC_LINK_TTL_MS = 15 * 60_000;

/**
 * Kind prefix + 18 random bytes (24 base64url chars), inside Telegram's /start alphabet [A-Za-z0-9_-]{1,64}.
 * The prefix keeps a deep-link code (bound to the browser that started it) out of the magic-link path.
 */
export type LoginVia = "poll" | "magic";
const PREFIX: Record<LoginVia, string> = { poll: "t", magic: "m" };
const newCode = (via: LoginVia) => PREFIX[via] + randomBytes(18).toString("base64url");
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);
const live = (r: LoginCode, now: Date) => r.expiresAt != null && r.expiresAt > now;

const codeRow = async (db: Db, code: string) =>
  (await db.select().from(loginCodes).where(eq(loginCodes.code, code)))[0] ?? null;

const personByTelegram = async (db: Db, telegramId: number) =>
  (await db.select().from(people).where(eq(people.telegramId, telegramId)))[0] ?? null;

/**
 * A new unclaimed code (random, URL-safe, ≥ 20 chars; Telegram allows [A-Za-z0-9_-]{1,64} in /start) valid
 * LOGIN_CODE_TTL_MS, and its deep link https://t.me/<TELEGRAM_BOT_USERNAME>?start=<code>.
 */
export async function startLogin(db: Db, now: Date): Promise<{ code: string; deepLink: string; expiresAt: Date }> {
  const code = newCode("poll");
  const expiresAt = later(now, LOGIN_CODE_TTL_MS);
  await db.insert(loginCodes).values({ code, expiresAt });
  return { code, deepLink: `https://t.me/${env.telegramBotUsername()}?start=${code}`, expiresAt };
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
  const { code, user } = input;
  if (!(await codeRow(db, code))) throw new ServiceError("NOT_FOUND", "That login link isn't valid.");
  // claim atomically: of two concurrent /start taps only one binds the code
  const claimed = await db
    .update(loginCodes)
    .set({
      telegramId: user.telegramId,
      username: user.username ?? null,
      firstName: user.firstName ?? null,
      claimedAt: now,
    })
    .where(and(eq(loginCodes.code, code), isNull(loginCodes.claimedAt), gt(loginCodes.expiresAt, now)))
    .returning({ code: loginCodes.code });
  if (!claimed.length) throw new ServiceError("GONE", "That login link has expired or was already used.");
  return upsertPersonFromTelegram(db, systemActor("login", "telegram"), { ...user, startedBot: true });
}

/** Bot side of a direct message: a code already claimed for this person, as <PUBLIC_ORIGIN>/login/magic?code=… */
export async function createMagicLink(db: Db, personId: string, now: Date): Promise<{ url: string; expiresAt: Date }> {
  const [p] = await db.select().from(people).where(eq(people.id, personId));
  if (!p) throw new ServiceError("NOT_FOUND", "Person not found.");
  const code = newCode("magic");
  const expiresAt = later(now, MAGIC_LINK_TTL_MS);
  await db.insert(loginCodes).values({
    code,
    telegramId: p.telegramId,
    username: p.username,
    firstName: p.firstName,
    claimedAt: now,
    expiresAt,
  });
  return { url: `${origin()}/login/magic?code=${encodeURIComponent(code)}`, expiresAt };
}

export type LoginState = { status: "pending" } | { status: "expired" } | { status: "ready"; person: Person };

/**
 * Read-only (GET of the magic link page, "Continue as …"): never consumes the code. Unknown, or a code of the
 * other kind than `via` (e.g. a seen t.me deep-link code tried as a magic link) = expired.
 */
export async function peekLogin(db: Db, code: string, via: LoginVia, now: Date): Promise<LoginState> {
  if (!code.startsWith(PREFIX[via])) return { status: "expired" };
  const r = await codeRow(db, code);
  if (!r || !live(r, now)) return { status: "expired" };
  if (!r.claimedAt || r.telegramId == null) return { status: "pending" };
  const person = await personByTelegram(db, r.telegramId);
  return person ? { status: "ready", person } : { status: "expired" };
}

/**
 * Single use. A claimed, unexpired code → its person, and the row is deleted in the same transaction; audited
 * session.login (entity person, workspaceId null, actor = the person). Not claimed yet → pending (the browser
 * keeps polling). Unknown/expired, or the other kind than `via` → expired.
 */
export async function finishLogin(
  db: Db,
  code: string,
  via: LoginVia,
  now: Date,
): Promise<{ status: "pending" } | { status: "expired" } | { status: "ok"; person: Person }> {
  const state = await peekLogin(db, code, via, now);
  if (state.status !== "ready") return state;
  const { person } = state;
  const actor = {
    kind: "admin" as const,
    id: person.id,
    channel: "web" as const,
    label: person.firstName ?? undefined,
  };
  try {
    return await mutate(
      db,
      actor,
      { action: "session.login", entity: "person", entityId: person.id, workspaceId: null },
      async (tx) => {
        const gone = await tx
          .delete(loginCodes)
          .where(and(eq(loginCodes.code, code), isNotNull(loginCodes.claimedAt)))
          .returning({ code: loginCodes.code });
        // a concurrent finish already used it: roll back (no audit row)
        if (!gone.length) throw new ServiceError("GONE", "Already used.");
        return { before: null, after: null, result: { status: "ok" as const, person } };
      },
    );
  } catch (e) {
    if (e instanceof ServiceError && e.code === "GONE") return { status: "expired" };
    throw e;
  }
}
