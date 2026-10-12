/** web-bot: POST /api/telegram, the bot webhook (SPEC §6c). Checks X-Telegram-Bot-Api-Secret-Token, then bot/handle.handleUpdate and bot/deliver.performReply. */
export const dynamic = "force-dynamic";

const notYet = () => Response.json({ error: "not implemented" }, { status: 501 });

export const POST = notYet;
