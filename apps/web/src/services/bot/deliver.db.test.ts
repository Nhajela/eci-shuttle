import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, notices, people, telegramMessages } from "@/db/schema";
import type { OutboxJob, TelegramPayload } from "../kernel";
import { callTelegram, deliverTelegram, performReply, sendNow } from "./deliver";

const db = () => testDb();
const TOKEN = "123:secret-token";

type Call = { url: string; method: string; body: Record<string, unknown> };

/** A fake Telegram: records every call; `reply` decides the answer per method. */
function fakeTelegram(reply: (method: string, body: Record<string, unknown>) => unknown = () => ({ message_id: 42 })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/").pop() as string;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, method, body });
    const r = reply(method, body);
    if (r instanceof Error) throw r;
    if (r && typeof r === "object" && "error_code" in r) {
      return new Response(JSON.stringify({ ok: false, ...r }), { status: (r as { error_code: number }).error_code });
    }
    return new Response(JSON.stringify({ ok: true, result: r }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const saved = process.env.TELEGRAM_BOT_TOKEN;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = saved;
});

const logFor = (chatId: number) => db().select().from(telegramMessages).where(eq(telegramMessages.chatId, chatId));
let chat = 5_000_000;
const nextChat = () => chat++ + Math.floor(Math.random() * 1e9);

describe("callTelegram", () => {
  it("POSTs JSON to the bot API and returns result", async () => {
    const t = fakeTelegram(() => ({ id: 1 }));
    await expect(callTelegram("getMe", {}, t.fetchImpl)).resolves.toEqual({ id: 1 });
    expect(t.calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it("throws with Telegram's error_code, description and retry_after, never the token", async () => {
    const t = fakeTelegram(() => ({
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 7 },
    }));
    const err = await callTelegram<never>("sendMessage", {}, t.fetchImpl).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 429, retryAfterS: 7 });
    expect(String(err.message)).toContain("Too Many Requests");
    expect(String(err.message)).not.toContain(TOKEN);
  });
});

describe("sendNow", () => {
  it("sends HTML with buttons and no link preview, and logs the message", async () => {
    const ws = await makeWorkspace(db());
    const chatId = nextChat();
    const t = fakeTelegram();
    const p: TelegramPayload = {
      chatId,
      html: "<b>Hi</b>",
      kind: "alert",
      buttons: [
        [
          { text: "Open", url: "https://x.test/a" },
          { text: "Ack", callbackData: "ack:1" },
        ],
      ],
    };
    await expect(
      deliverTelegram(db(), { workspaceId: ws.id, payload: p } as unknown as OutboxJob, t.fetchImpl),
    ).resolves.toEqual({
      ok: true,
    });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({
      method: "sendMessage",
      body: {
        chat_id: chatId,
        text: "<b>Hi</b>",
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Open", url: "https://x.test/a" },
              { text: "Ack", callback_data: "ack:1" },
            ],
          ],
        },
      },
    });
    const [log] = await logFor(chatId);
    expect(log).toMatchObject({ workspaceId: ws.id, kind: "alert", text: "<b>Hi</b>", ok: true, messageId: 42 });
  });

  it("without a bot token only logs (dev outbox)", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const chatId = nextChat();
    const t = fakeTelegram();
    await expect(sendNow(db(), { chatId, html: "x", kind: "reply" }, t.fetchImpl)).resolves.toEqual({ ok: true });
    expect(t.calls).toHaveLength(0);
    expect(await logFor(chatId)).toMatchObject([{ ok: true, messageId: null }]);
  });

  it("in production without a bot token it fails for good instead of faking a send", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    vi.stubEnv("NODE_ENV", "production");
    try {
      const chatId = nextChat();
      const t = fakeTelegram();
      await expect(sendNow(db(), { chatId, html: "x", kind: "reply" }, t.fetchImpl)).resolves.toEqual({
        ok: false,
        retry: false,
        error: "no TELEGRAM_BOT_TOKEN",
      });
      expect(t.calls).toHaveLength(0);
      expect(await logFor(chatId)).toMatchObject([{ ok: false, error: "no TELEGRAM_BOT_TOKEN" }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pins after sending when pin, and records the group post for a notice", async () => {
    const ws = await makeWorkspace(db());
    const [n] = await db()
      .insert(notices)
      .values({ workspaceId: ws.id, text: "x", placements: ["everywhere"] })
      .returning();
    const chatId = -nextChat();
    const t = fakeTelegram((m) => (m === "sendMessage" ? { message_id: 777 } : true));
    const r = await sendNow(
      db(),
      { chatId, html: "notice", kind: "notice", pin: true, ref: { kind: "notice_group_post", noticeId: n!.id } },
      t.fetchImpl,
    );
    expect(r).toEqual({ ok: true });
    expect(t.calls.map((c) => c.method)).toEqual(["sendMessage", "pinChatMessage"]);
    expect(t.calls[1]?.body).toMatchObject({ chat_id: chatId, message_id: 777 });
    const [after] = await db().select().from(notices).where(eq(notices.id, n!.id));
    expect(after?.groupMessageId).toBe(777);
  });

  it("a failed pin still counts as sent (a retry would post twice)", async () => {
    const t = fakeTelegram((m) =>
      m === "sendMessage" ? { message_id: 1 } : { error_code: 400, description: "no rights" },
    );
    await expect(
      sendNow(db(), { chatId: -nextChat(), html: "x", kind: "notice", pin: true }, t.fetchImpl),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it("unpins instead of sending when unpinMessageId", async () => {
    const chatId = -nextChat();
    const t = fakeTelegram(() => true);
    await expect(sendNow(db(), { chatId, html: "", kind: "notice", unpinMessageId: 9 }, t.fetchImpl)).resolves.toEqual({
      ok: true,
    });
    expect(t.calls).toMatchObject([{ method: "unpinChatMessage", body: { chat_id: chatId, message_id: 9 } }]);
  });

  it("403 marks the person as having blocked the bot (audited) and gives up", async () => {
    const person = await makePerson(db());
    const chatId = nextChat();
    const t = fakeTelegram(() => ({ error_code: 403, description: "Forbidden: bot was blocked by the user" }));
    const r = await sendNow(db(), { chatId, html: "x", kind: "arrival", personId: person!.id }, t.fetchImpl);
    expect(r).toMatchObject({ ok: false, retry: false });
    const [p] = await db().select().from(people).where(eq(people.id, person!.id));
    expect(p?.blockedBotAt).toBeInstanceOf(Date);
    const audits = await db().select().from(auditLog).where(eq(auditLog.entityId, person!.id));
    expect(audits.map((a) => a.action)).toContain("person.blocked_bot");
    expect(await logFor(chatId)).toMatchObject([
      { ok: false, messageId: null, error: expect.stringContaining("blocked") },
    ]);
  });

  it("429 retries after Telegram's retry_after", async () => {
    const t = fakeTelegram(() => ({
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 3 },
    }));
    const r = await sendNow(db(), { chatId: nextChat(), html: "x", kind: "digest" }, t.fetchImpl);
    expect(r).toMatchObject({ ok: false, retry: true, retryAfterMs: 3_000 });
  });

  it("5xx and network errors retry; other 4xx give up", async () => {
    const send = (fetchImpl: typeof fetch) =>
      sendNow(db(), { chatId: nextChat(), html: "x", kind: "alert" }, fetchImpl);
    expect(await send(fakeTelegram(() => ({ error_code: 502, description: "Bad Gateway" })).fetchImpl)).toMatchObject({
      ok: false,
      retry: true,
    });
    expect(await send(fakeTelegram(() => new TypeError("fetch failed")).fetchImpl)).toMatchObject({
      ok: false,
      retry: true,
      error: expect.stringContaining("fetch failed"),
    });
    expect(
      await send(fakeTelegram(() => ({ error_code: 400, description: "Bad Request: chat not found" })).fetchImpl),
    ).toMatchObject({ ok: false, retry: false });
  });
});

describe("sendNow with an animation (GIF moments)", () => {
  const GIF = "http://localhost:3000/gifs/welcome.gif";
  const buttons = [[{ text: "Stop updates", callbackData: "nunsub:1" }]];

  it("sends sendAnimation with the html as caption, same buttons, and logs it", async () => {
    const chatId = nextChat();
    const t = fakeTelegram(() => ({ message_id: 7 }));
    const r = await sendNow(db(), { chatId, html: "<b>Hi</b>", kind: "update", buttons, animation: GIF }, t.fetchImpl);
    expect(r).toEqual({ ok: true });
    expect(t.calls.map((c) => c.method)).toEqual(["sendAnimation"]);
    expect(t.calls[0]?.body).toMatchObject({
      chat_id: chatId,
      animation: GIF,
      caption: "<b>Hi</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Stop updates", callback_data: "nunsub:1" }]] },
    });
    expect(await logFor(chatId)).toMatchObject([{ kind: "update", text: "<b>Hi</b>", ok: true, messageId: 7 }]);
  });

  it("a caption over 1024 chars goes as a plain message instead", async () => {
    const chatId = nextChat();
    const t = fakeTelegram();
    const html = "x".repeat(1025);
    await expect(sendNow(db(), { chatId, html, kind: "update", animation: GIF }, t.fetchImpl)).resolves.toEqual({
      ok: true,
    });
    expect(t.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(t.calls[0]?.body).toMatchObject({ text: html });
  });

  it("when sendAnimation fails (bad URL, 400) the text still goes out as a plain message; no update is lost", async () => {
    const chatId = nextChat();
    const t = fakeTelegram((m) =>
      m === "sendAnimation"
        ? { error_code: 400, description: "Bad Request: wrong file identifier" }
        : { message_id: 9 },
    );
    const r = await sendNow(db(), { chatId, html: "text", kind: "update", buttons, animation: GIF }, t.fetchImpl);
    expect(r).toEqual({ ok: true });
    expect(t.calls.map((c) => c.method)).toEqual(["sendAnimation", "sendMessage"]);
    expect(t.calls[1]?.body).toMatchObject({ chat_id: chatId, text: "text", parse_mode: "HTML" });
    expect(await logFor(chatId)).toMatchObject([{ ok: true, messageId: 9 }]);
  });

  it("a blocked bot (403) or a 429 on the animation is reported as such, not retried as text", async () => {
    const person = await makePerson(db());
    const chatId = nextChat();
    const t = fakeTelegram(() => ({ error_code: 403, description: "Forbidden: bot was blocked by the user" }));
    const r = await sendNow(
      db(),
      { chatId, html: "x", kind: "update", animation: GIF, personId: person!.id },
      t.fetchImpl,
    );
    expect(r).toMatchObject({ ok: false, retry: false });
    expect(t.calls.map((c) => c.method)).toEqual(["sendAnimation"]);
    const t2 = fakeTelegram(() => ({ error_code: 429, description: "Too Many", parameters: { retry_after: 2 } }));
    const r2 = await sendNow(db(), { chatId: nextChat(), html: "x", kind: "update", animation: GIF }, t2.fetchImpl);
    expect(r2).toMatchObject({ ok: false, retry: true, retryAfterMs: 2_000 });
    expect(t2.calls.map((c) => c.method)).toEqual(["sendAnimation"]);
  });

  it("a network error on the animation retries the whole job (nothing was sent)", async () => {
    const t = fakeTelegram(() => new TypeError("fetch failed"));
    const r = await sendNow(db(), { chatId: nextChat(), html: "x", kind: "update", animation: GIF }, t.fetchImpl);
    expect(r).toMatchObject({ ok: false, retry: true });
    expect(t.calls.map((c) => c.method)).toEqual(["sendAnimation"]);
  });
});

describe("performReply", () => {
  it("answers the callback, edits the message, then sends each payload in order", async () => {
    const chatId = nextChat();
    const t = fakeTelegram((m) => (m === "sendMessage" ? { message_id: 1 } : true));
    await performReply(
      db(),
      {
        answerCallback: { callbackQueryId: "q1", text: "Done", showAlert: true },
        edit: { chatId, messageId: 5, html: "edited", buttons: [[{ text: "B", callbackData: "b" }]] },
        send: [
          { chatId, html: "one", kind: "reply" },
          { chatId, html: "two", kind: "reply" },
        ],
      },
      t.fetchImpl,
    );
    expect(t.calls.map((c) => c.method)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
      "sendMessage",
      "sendMessage",
    ]);
    expect(t.calls[0]?.body).toEqual({ callback_query_id: "q1", text: "Done", show_alert: true });
    expect(t.calls[1]?.body).toMatchObject({
      chat_id: chatId,
      message_id: 5,
      text: "edited",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "B", callback_data: "b" }]] },
    });
    expect((await logFor(chatId)).map((l) => l.text).sort()).toEqual(["one", "two"]);
  });

  it("a failed edit (message not modified) does not stop the sends", async () => {
    const chatId = nextChat();
    const t = fakeTelegram((m) =>
      m === "editMessageText" ? { error_code: 400, description: "message is not modified" } : { message_id: 1 },
    );
    await performReply(
      db(),
      { edit: { chatId, messageId: 5, html: "same" }, send: [{ chatId, html: "next", kind: "reply" }] },
      t.fetchImpl,
    );
    expect(t.calls.map((c) => c.method)).toEqual(["editMessageText", "sendMessage"]);
  });
});
