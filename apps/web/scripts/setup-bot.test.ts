import { describe, expect, it } from "vitest";
import { COMMANDS, setupBot } from "./setup-bot.mjs";

const fakeTelegram = (fail?: string) => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const method = url.split("/").pop();
    return Response.json(
      method === fail ? { ok: false, error_code: 400, description: "Bad Request: nope" } : { ok: true, result: true },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const opts = { token: "123:abc", origin: "https://eci-shuttle.example.com", secret: "s".repeat(32) };

describe("setupBot", () => {
  it("points the webhook at <origin>/api/telegram with the secret and the four update kinds (edited_message carries live location), then sets commands for private chats only", async () => {
    const t = fakeTelegram();
    const url = await setupBot({ ...opts, fetchImpl: t.fetchImpl });
    expect(url).toBe("https://eci-shuttle.example.com/api/telegram");
    expect(t.calls.map((c) => c.url)).toEqual([
      "https://api.telegram.org/bot123:abc/setWebhook",
      "https://api.telegram.org/bot123:abc/deleteMyCommands",
      "https://api.telegram.org/bot123:abc/setMyCommands",
    ]);
    expect(t.calls[0]?.body).toEqual({
      url,
      secret_token: opts.secret,
      allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"],
    });
    expect(t.calls[1]?.body).toEqual({}); // default scope: drops any old group menu
    expect(t.calls[2]?.body).toEqual({ commands: COMMANDS, scope: { type: "all_private_chats" } });
  });

  it("tolerates a trailing slash on the origin", async () => {
    const t = fakeTelegram();
    expect(await setupBot({ ...opts, origin: `${opts.origin}/`, fetchImpl: t.fetchImpl })).toBe(
      "https://eci-shuttle.example.com/api/telegram",
    );
  });

  it("fails loudly with Telegram's description, without leaking the token", async () => {
    const t = fakeTelegram("setWebhook");
    const err = await setupBot({ ...opts, fetchImpl: t.fetchImpl }).catch((e: Error) => e);
    expect(String(err)).toMatch(/setWebhook.*Bad Request: nope/);
    expect(String(err)).not.toContain("123:abc");
  });

  it("refuses a short secret (Telegram allows 1-256 chars of A-Z a-z 0-9 _ -)", async () => {
    const t = fakeTelegram();
    await expect(setupBot({ ...opts, secret: "short", fetchImpl: t.fetchImpl })).rejects.toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    );
    await expect(setupBot({ ...opts, secret: `${"s".repeat(32)}!`, fetchImpl: t.fetchImpl })).rejects.toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    );
    expect(t.calls).toEqual([]);
  });

  it("command names are valid for Telegram (lowercase, ≤ 32 chars, description ≤ 256)", () => {
    for (const c of COMMANDS) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });
});
