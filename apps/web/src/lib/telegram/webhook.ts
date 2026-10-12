/** web-bot: webhook plumbing for app/api/telegram. Sending lives in services/bot/deliver. */
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

const sha = (s: string) => createHash("sha256").update(s).digest();

/** True when X-Telegram-Bot-Api-Secret-Token equals TELEGRAM_WEBHOOK_SECRET (constant-time compare). */
export function verifyWebhookSecret(req: Request): boolean {
  const expected = env.telegramWebhookSecret();
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  // hashing first gives equal-length buffers, so the compare leaks neither content nor length
  return got !== null && timingSafeEqual(sha(got), sha(expected));
}
