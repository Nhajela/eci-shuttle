/** web-bot: POST /api/telegram, the bot webhook (SPEC §6c). Checks X-Telegram-Bot-Api-Secret-Token, then bot/handle.handleUpdate and bot/deliver.performReply. */
import { db } from "@/db";
import { verifyWebhookSecret } from "@/lib/telegram/webhook";
import { performReply } from "@/services/bot/deliver";
import { handleUpdate } from "@/services/bot/handle";
import type { TgUpdate } from "@/services/bot/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!verifyWebhookSecret(req)) return new Response("unauthorized", { status: 401 });

  const update = (await req.json().catch(() => null)) as TgUpdate | null;
  if (typeof update?.update_id !== "number") return new Response("bad update", { status: 400 });

  try {
    const reply = await handleUpdate(db(), update, new Date());
    await performReply(db(), reply);
  } catch (e) {
    // still 200: a non-2xx makes Telegram redeliver this update (and repeat its side effects) for hours
    console.error("telegram webhook: update", update.update_id, e);
  }
  return Response.json({ ok: true });
}
