/** web-bot: webhook plumbing for app/api/telegram. Sending lives in services/bot/deliver. */
import { notImplemented } from "@eci-shuttle/shared";

/** True when X-Telegram-Bot-Api-Secret-Token equals TELEGRAM_WEBHOOK_SECRET (constant-time compare). */
export function verifyWebhookSecret(req: Request): boolean {
  return notImplemented(req);
}
