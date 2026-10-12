/** web-bot: POST /api/telegram, the bot webhook (SPEC §6c). Checks X-Telegram-Bot-Api-Secret-Token, then bot/handle.handleUpdate and bot/deliver.performReply. */
import { db } from "@/db";
import { verifyWebhookSecret } from "@/lib/telegram/webhook";
import { performReply } from "@/services/bot/deliver";
import { handleUpdate } from "@/services/bot/handle";
import type { TgUpdate } from "@/services/bot/types";

export const dynamic = "force-dynamic";

// ponytail: in-process only (one web container). Survives neither a restart nor a second replica; upgrade to a
// telegram_updates(update_id pk) insert ON CONFLICT DO NOTHING once that table is in the schema contract.
const seen = new Set<number>();
const SEEN_MAX = 1000;

export async function POST(req: Request) {
  if (!verifyWebhookSecret(req)) return new Response("unauthorized", { status: 401 });

  const update = (await req.json().catch(() => null)) as TgUpdate | null;
  if (typeof update?.update_id !== "number") return new Response("bad update", { status: 400 });

  // Telegram redelivers on a slow reply or a dropped connection: never run a /start claim or a confirm twice
  if (seen.has(update.update_id)) return Response.json({ ok: true });
  seen.add(update.update_id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as number);

  try {
    const reply = await handleUpdate(db(), update, new Date());
    await performReply(db(), reply);
  } catch (e) {
    // still 200: a non-2xx makes Telegram redeliver this update (and repeat its side effects) for hours
    console.error("telegram webhook: update", update.update_id, e);
  }
  return Response.json({ ok: true });
}
