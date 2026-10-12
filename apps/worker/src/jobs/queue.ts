import { notImplemented } from "@eci-shuttle/shared";
import type { Job } from "../job";

/**
 * Every 2 s, draining until nothing is due or ~1.5 s passed (SPEC §2b "continuous"): the outbox is the queue
 * (no queue library). Claim due rows (status pending, run_after ≤ now) with `FOR UPDATE SKIP LOCKED` in small
 * batches, deliver with bot/deliver.deliverTelegram (kind telegram) or devices/push.deliverPush (kind push), then:
 * ok → status sent, sent_at; retry → attempts+1, run_after = now + backoff (5 s · 2^attempts, max 10 min), dead
 * after 8 attempts; retry false → dead with the error. Pacing: ≤ 25 Telegram sends/s overall and ≤ 1/s per chat
 * (Telegram limits); paced broadcasts just stay pending for the next tick. Outbox status columns are bookkeeping,
 * not audited.
 */
export const queue: Job = {
  name: "queue",
  schedule: "*/2 * * * * *",
  run: (ctx) => notImplemented(ctx),
};
