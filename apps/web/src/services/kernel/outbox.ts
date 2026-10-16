import type { Db } from "@/db";
import { outbox } from "@/db/schema";

export type OutboxJob = typeof outbox.$inferSelect;

/** One inline-keyboard button. callbackData is ≤ 64 bytes (Telegram limit). */
export type TelegramButton = { text: string; url: string } | { text: string; callbackData: string };

/** A Telegram send, delivered by auth-bot's deliverTelegram and logged in telegram_messages. */
export type TelegramPayload = {
  chatId: number;
  /** Telegram HTML, already escaped */
  html: string;
  /** telegram_messages.kind: alert, notice, broadcast, reply, digest, login, arrival … */
  kind: string;
  /** rows of buttons */
  buttons?: TelegramButton[][];
  /**
   * A GIF (URL under origin()) sent with sendAnimation and `html` as its caption; a caption over 1024 chars or a
   * failed sendAnimation falls back to a plain sendMessage (deliver.ts). Owner-approved additive change.
   */
  animation?: string;
  /** pin the sent message in the chat (group notices) */
  pin?: boolean;
  /** instead of sending: unpin this message id */
  unpinMessageId?: number;
  /** recipient person, so a 403 can mark people.blocked_bot_at */
  personId?: string;
  /** after a successful send, tell svc-notices the group message id (for the unpin at the end) */
  ref?: { kind: "notice_group_post"; noticeId: string };
};

/** What a deliverer (deliverPush, deliverTelegram) tells the worker queue job. */
export type DeliveryResult =
  | { ok: true }
  /** retry later with backoff (network, 5xx), or after `retryAfterMs` when the far side says (Telegram 429) */
  | { ok: false; retry: true; error: string; retryAfterMs?: number }
  /** give up: mark the job dead (no token, blocked bot, DeviceNotRegistered) */
  | { ok: false; retry: false; error: string };

/** "Sync now" (data-only Expo push), delivered by svc-devices' deliverPush. */
export type PushPayload = { deviceId: string; reason: string };

type Job = { kind: "telegram"; payload: TelegramPayload } | { kind: "push"; payload: PushPayload };

/**
 * Queue a side effect in the caller's transaction, so it exists iff the change committed. The worker `queue`
 * job sends it with pacing and retries. Returns null when dedupeKey already exists (idempotent enqueue).
 */
export async function enqueue(
  db: Db,
  job: Job & { workspaceId: string | null; dedupeKey?: string; runAfter?: Date },
): Promise<OutboxJob | null> {
  const rows = await db
    .insert(outbox)
    .values({
      workspaceId: job.workspaceId,
      kind: job.kind,
      payload: job.payload,
      dedupeKey: job.dedupeKey ?? null,
      runAfter: job.runAfter ?? new Date(),
    })
    .onConflictDoNothing({ target: outbox.dedupeKey })
    .returning();
  return rows[0] ?? null;
}
