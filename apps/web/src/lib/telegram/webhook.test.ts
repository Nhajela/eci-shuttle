import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyWebhookSecret } from "./webhook";

const SECRET = "s".repeat(32);
const req = (headers: Record<string, string> = {}) =>
  new Request("https://x.test/api/telegram", { method: "POST", headers });

const saved = process.env.TELEGRAM_WEBHOOK_SECRET;
beforeEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = saved;
});

describe("verifyWebhookSecret", () => {
  it("accepts the right secret", () => {
    expect(verifyWebhookSecret(req({ "X-Telegram-Bot-Api-Secret-Token": SECRET }))).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyWebhookSecret(req())).toBe(false);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(verifyWebhookSecret(req({ "X-Telegram-Bot-Api-Secret-Token": "t".repeat(32) }))).toBe(false);
  });

  it("rejects a prefix of the secret", () => {
    expect(verifyWebhookSecret(req({ "X-Telegram-Bot-Api-Secret-Token": SECRET.slice(0, 16) }))).toBe(false);
  });

  it("throws when the server has no secret configured (misconfig is loud, never open)", () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect(() => verifyWebhookSecret(req({ "X-Telegram-Bot-Api-Secret-Token": "" }))).toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    );
  });
});
