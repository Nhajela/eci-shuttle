/**
 * Server env, validated on first use (so `next build` needs none of it). Never import from client components.
 * One origin for everything (SPEC §2a): nothing hardcodes a host, always use origin().
 */
import { z } from "zod";

const Env = z.object({
  PUBLIC_ORIGIN: z.url().transform((s) => s.replace(/\/+$/, "")),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  /** signs session cookies */
  SESSION_SECRET: z.string().min(32),
  /** comma-separated; the first seals new tokens/proposals, the rest still open old ones (rotation) */
  TOKEN_SECRETS: z
    .string()
    .min(32)
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  /** optional: Expo push works without it unless "enhanced push security" is on */
  EXPO_ACCESS_TOKEN: z.string().optional(),
  /** optional IST date: from this day on the cleanup job deletes raw pings (after the event, SPEC §4) */
  PINGS_DELETE_AFTER: z.iso.date().optional(),
});
export type Env = z.infer<typeof Env>;

function read<K extends keyof Env>(key: K): Env[K] {
  const r = Env.shape[key].safeParse(process.env[key]);
  if (!r.success) throw new Error(`Env ${key} is missing or invalid: ${r.error.issues[0]?.message}`);
  return r.data as Env[K];
}

export const env = {
  origin: () => read("PUBLIC_ORIGIN"),
  databaseUrl: () => read("DATABASE_URL"),
  telegramBotToken: () => read("TELEGRAM_BOT_TOKEN"),
  telegramBotUsername: () => read("TELEGRAM_BOT_USERNAME"),
  telegramWebhookSecret: () => read("TELEGRAM_WEBHOOK_SECRET"),
  sessionSecret: () => read("SESSION_SECRET"),
  tokenSecrets: () => read("TOKEN_SECRETS"),
  expoAccessToken: () => read("EXPO_ACCESS_TOKEN"),
  pingsDeleteAfter: () => read("PINGS_DELETE_AFTER"),
};

/** PUBLIC_ORIGIN without a trailing slash, e.g. https://eci-shuttle.positivesumcompany.com */
export const origin = env.origin;
