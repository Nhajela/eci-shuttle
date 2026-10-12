// web-bot: `pnpm bot:setup` (SPEC §2a): setWebhook to <PUBLIC_ORIGIN>/api/telegram with TELEGRAM_WEBHOOK_SECRET,
// allowed_updates [message, callback_query, my_chat_member], and setMyCommands. Run after every host move.
import { pathToFileURL } from "node:url";

/** The menu in private chats (never the group). Admin commands (/status /today /notice /silence) stay unlisted: ops know them. */
export const COMMANDS = [
  { command: "shuttle", description: "Where is the shuttle? Pick your spot" },
  { command: "stop", description: "Stop all my shuttle alerts" },
  { command: "login", description: "Log in to admin (ops team)" },
];

/** Registers the webhook and the command menu; returns the webhook URL. Throws on any Telegram error. */
export async function setupBot({ token, origin, secret, fetchImpl = fetch }) {
  // same rule as lib/env (≥ 16) plus Telegram's charset for secret_token
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret ?? "")) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16-256 chars of A-Z a-z 0-9 _ -");
  }
  const call = async (method, params) => {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`${method} failed: ${body.description ?? `HTTP ${res.status}`}`);
    return body.result;
  };
  const url = `${origin.replace(/\/+$/, "")}/api/telegram`;
  await call("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query", "my_chat_member"],
  });
  // private chats only: /login in the main group would post a login link everyone can see
  await call("deleteMyCommands", {}); // clears a menu an older setup left on the default (group) scope
  await call("setMyCommands", { commands: COMMANDS, scope: { type: "all_private_chats" } });
  return url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const need = (k) => {
    if (!process.env[k]) throw new Error(`${k} is missing (set it in .env.local)`);
    return process.env[k];
  };
  const url = await setupBot({
    token: need("TELEGRAM_BOT_TOKEN"),
    origin: need("PUBLIC_ORIGIN"),
    secret: need("TELEGRAM_WEBHOOK_SECRET"),
  });
  console.log(`Webhook set: ${url} (+ commands)`);
}
