import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loginCodes } from "@/db/schema";
import type { Person, Workspace } from "@/db/types";
import { finishLogin, LOGIN_CODE_TTL_MS, startLogin } from "../auth/codes";
import { onShuttle } from "./attendee";
import { onLogin, onLoginButton, onStart } from "./start";
import type { BotContext } from "./types";

vi.mock("./attendee", () => ({ onShuttle: vi.fn() }));

const db = () => testDb();
const NOW = new Date("2026-10-15T04:30:00Z");
const SHUTTLE = { chatId: 4242, html: "Where are you?", kind: "reply" as const };

const ctxFor = (person: Person, workspace: Workspace, now = NOW): BotContext => ({
  db: db(),
  now,
  person,
  chatId: 4242,
  workspace,
});
const htmls = (r: { send: { html: string }[] }) => r.send.map((s) => s.html);

beforeAll(() => {
  process.env.TELEGRAM_BOT_USERNAME ||= "eci_shuttle_test_bot";
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(onShuttle).mockResolvedValue({ send: [SHUTTLE] });
});

describe("/start <code>", () => {
  const tap = (code: string, chatId = 4242) => ({
    id: "cbq1",
    from: { id: chatId },
    message: { message_id: 7, date: 0, chat: { id: chatId, type: "private" as const } },
    data: `login:${code}`,
  });

  it("only asks to confirm: the code stays unclaimed and the browser keeps polling", async () => {
    const ws = await makeWorkspace(db());
    const person = await makePerson(db(), { username: "asha", firstName: "Asha" });
    const { code } = await startLogin(db(), NOW);

    const r = await onStart(ctxFor(person, ws), code);
    expect(r.send).toHaveLength(1);
    expect(r.send[0]).toMatchObject({ chatId: 4242, kind: "reply", personId: person.id });
    expect(r.send[0].html).toContain("Only tap if you just pressed Log in on the website (started 10:00)");
    expect(r.send[0].buttons).toEqual([[{ text: "Yes, log me in", callbackData: `login:${code}` }]]);

    const [row] = await db().select().from(loginCodes).where(eq(loginCodes.code, code));
    expect(row.claimedAt).toBeNull();
    expect(await finishLogin(db(), code, "poll", NOW)).toMatchObject({ status: "pending" });
    expect(onShuttle).not.toHaveBeenCalled();
  });

  it("[Yes, log me in] claims the code for the presser; the browser then logs in", async () => {
    const ws = await makeWorkspace(db());
    const person = await makePerson(db(), { username: "asha", firstName: "Asha" });
    const { code } = await startLogin(db(), NOW);

    const r = await onLoginButton(ctxFor(person, ws), code, tap(code));
    expect(r.edit).toMatchObject({ chatId: 4242, messageId: 7, html: "You're logged in. Go back to your browser." });
    expect(r.answerCallback).toMatchObject({ callbackQueryId: "cbq1" });

    const [row] = await db().select().from(loginCodes).where(eq(loginCodes.code, code));
    expect(row).toMatchObject({ telegramId: person.telegramId, username: "asha", firstName: "Asha" });
    expect(await finishLogin(db(), code, "poll", NOW)).toMatchObject({ status: "ok", person: { id: person.id } });
  });

  it("a button pressed outside the presser's own chat with the bot claims nothing", async () => {
    const ws = await makeWorkspace(db());
    const person = await makePerson(db());
    const { code } = await startLogin(db(), NOW);
    const q = { ...tap(code), from: { id: 999 } };
    const r = await onLoginButton(ctxFor(person, ws), code, q);
    expect(r.edit).toBeUndefined();
    expect(await finishLogin(db(), code, "poll", NOW)).toMatchObject({ status: "pending" });
  });

  it("unknown, expired or already used → start again from the website", async () => {
    const ws = await makeWorkspace(db());
    const person = await makePerson(db());
    const expired = "That login link expired. Start again from the website.";
    expect(htmls(await onStart(ctxFor(person, ws), "tNoSuchCode000000000000000"))).toEqual([expired]);

    const { code } = await startLogin(db(), NOW);
    const late = new Date(NOW.getTime() + LOGIN_CODE_TTL_MS + 1);
    expect(htmls(await onStart(ctxFor(person, ws, late), code))).toEqual([expired]);
    expect((await onLoginButton(ctxFor(person, ws, late), code, tap(code))).edit?.html).toBe(expired);

    const fresh = await startLogin(db(), NOW);
    await onLoginButton(ctxFor(person, ws), fresh.code, tap(fresh.code));
    const other = await makePerson(db());
    expect(htmls(await onStart(ctxFor(other, ws), fresh.code))).toEqual([expired]);
    expect((await onLoginButton(ctxFor(other, ws), fresh.code, tap(fresh.code))).edit?.html).toBe(expired);
  });
});

describe("plain /start", () => {
  it("an attendee gets the /shuttle intro only", async () => {
    const ws = await makeWorkspace(db());
    const person = await makePerson(db());
    const ctx = ctxFor(person, ws);
    const r = await onStart(ctx, null);
    expect(onShuttle).toHaveBeenCalledWith(ctx, null);
    expect(r.send).toEqual([SHUTTLE]);
  });

  it("an admin gets a magic login link, then the /shuttle intro", async () => {
    const ws = await makeWorkspace(db());
    const { person } = await makeAdmin(db(), ws.id, "viewer");
    const r = await onStart(ctxFor(person, ws), "  ");
    expect(r.send).toHaveLength(2);
    expect(r.send[0]).toMatchObject({ chatId: 4242, kind: "reply", personId: person.id });
    expect(r.send[0].html.startsWith(`Log in to admin: <a href="${process.env.PUBLIC_ORIGIN}/login/magic?code=m`)).toBe(
      true,
    );
    expect(r.send[1]).toEqual(SHUTTLE);
  });
});

describe("/login", () => {
  it("a member gets a working magic link (valid 15 min, IST expiry)", async () => {
    const ws = await makeWorkspace(db());
    const { person } = await makeAdmin(db(), ws.id);
    const r = await onLogin(ctxFor(person, ws));
    const html = r.send[0].html;
    expect(html).toContain("Valid until 10:15."); // 04:45Z = 10:15 IST
    const code = decodeURIComponent(/code=([^"]+)"/.exec(html)?.[1] ?? "");
    expect(await finishLogin(db(), code, "magic", NOW)).toMatchObject({ status: "ok", person: { id: person.id } });
  });

  it("someone without a membership is told login is for the ops team, and no code is made", async () => {
    const ws = await makeWorkspace(db());
    const person = await makePerson(db());
    const r = await onLogin(ctxFor(person, ws));
    expect(htmls(r)).toEqual(["Login is only for the ops team. Send /shuttle for the next shuttle."]);
    expect(await db().select().from(loginCodes).where(eq(loginCodes.telegramId, person.telegramId))).toEqual([]);
  });
});
