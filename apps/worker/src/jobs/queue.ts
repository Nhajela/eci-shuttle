import { and, asc, eq, lte, notInArray } from "drizzle-orm";
import type { Db } from "@/db";
import { outbox } from "@/db/schema";
import { deliverTelegram } from "@/services/bot/deliver";
import { deliverPush } from "@/services/devices/push";
import type { DeliveryResult, OutboxJob } from "@/services/kernel";
import type { Job } from "../job";

export const MAX_ATTEMPTS = 8;
const PER_SECOND = 25;
const BATCH = 50;

/** Wait before the next try after `attempts` earlier tries: 5 s · 2^attempts, at most 10 min. */
export const backoffMs = (attempts: number) => Math.min(5_000 * 2 ** attempts, 600_000);

/** Telegram limits: ≤ 25 sends/s overall, ≤ 1/s per chat. Lives across ticks; times are epoch ms. */
export class Pacer {
  private recent: number[] = [];
  private lastByChat = new Map<number, number>();

  chatReady(chatId: number, now: number) {
    const last = this.lastByChat.get(chatId);
    return last === undefined || now - last >= 1_000;
  }

  /** 0 when a send may go now, else how long until the oldest of the last 25 sends leaves the 1 s window. */
  globalWaitMs(now: number) {
    this.recent = this.recent.filter((t) => now - t < 1_000);
    return this.recent.length < PER_SECOND ? 0 : (this.recent[0] as number) + 1_000 - now;
  }

  record(chatId: number, now: number) {
    this.recent.push(now);
    this.lastByChat.set(chatId, now);
    if (this.lastByChat.size > 1_000) {
      for (const [c, t] of this.lastByChat) if (now - t >= 1_000) this.lastByChat.delete(c);
    }
  }
}

type Deliver = (db: Db, job: OutboxJob) => Promise<DeliveryResult>;
export type Deliverers = { telegram: Deliver; push: Deliver };

export type DrainDeps = {
  deliver?: Deliverers;
  pacer?: Pacer;
  /** how long one tick may keep draining */
  budgetMs?: number;
  /** elapsed-time source (ms); the tick's `now` plus elapsed is the time written to rows */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const realDeliverers: Deliverers = { telegram: (db, j) => deliverTelegram(db, j), push: (db, j) => deliverPush(db, j) };

/**
 * Drain due outbox rows until nothing is due or the budget is spent. Rows are claimed with
 * FOR UPDATE SKIP LOCKED and delivered with `db` (not the claim transaction), so a deliverer's own writes
 * (telegram_messages, blocked_bot_at) never roll back with the bookkeeping. Telegram rows over the pacing limits
 * stay pending; push rows are never held back by them.
 */
export async function drainQueue(db: Db, now: Date, deps: DrainDeps = {}) {
  const deliver = deps.deliver ?? realDeliverers;
  const pacer = deps.pacer ?? defaultPacer;
  const budget = deps.budgetMs ?? 1_500;
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = clock();
  const at = () => new Date(now.getTime() + clock() - t0);
  const outOfTime = () => clock() - t0 >= budget;

  const stats = { sent: 0, retried: 0, dead: 0, paced: 0 };
  // this tick only: chat-paced rows wait for the next tick; globally paced rows wait for the window to free up
  const chatPaced = new Set<number>();
  let globalPaced = new Set<number>();

  while (!outOfTime()) {
    const skip = [...chatPaced, ...globalPaced];
    let progressed = false;
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.status, "pending"),
            lte(outbox.runAfter, at()),
            skip.length ? notInArray(outbox.id, skip) : undefined,
          ),
        )
        .orderBy(asc(outbox.runAfter), asc(outbox.id))
        .limit(BATCH)
        .for("update", { skipLocked: true });

      for (const row of rows) {
        if (outOfTime()) break;
        const t = at();
        if (row.kind === "telegram") {
          const chatId = Number((row.payload as { chatId?: unknown }).chatId);
          if (!pacer.chatReady(chatId, t.getTime())) {
            chatPaced.add(row.id);
            stats.paced++;
            continue;
          }
          if (pacer.globalWaitMs(t.getTime()) > 0) {
            globalPaced.add(row.id);
            continue;
          }
          pacer.record(chatId, t.getTime());
        }
        progressed = true;
        const fn = row.kind === "telegram" || row.kind === "push" ? deliver[row.kind] : null;
        let r: DeliveryResult;
        try {
          r = fn ? await fn(db, row) : { ok: false, retry: false, error: `unknown outbox kind ${row.kind}` };
        } catch (e) {
          r = { ok: false, retry: true, error: e instanceof Error ? e.message : String(e) };
        }
        const done = at();
        // bookkeeping, not audited (CONTRACTS: outbox status)
        if (r.ok) {
          await tx.update(outbox).set({ status: "sent", sentAt: done, error: null }).where(eq(outbox.id, row.id));
          stats.sent++;
        } else {
          const attempts = row.attempts + 1;
          const dead = !r.retry || attempts >= MAX_ATTEMPTS;
          await tx
            .update(outbox)
            .set({
              attempts,
              error: r.error,
              ...(dead
                ? { status: "dead" as const }
                : { runAfter: new Date(done.getTime() + backoffMs(row.attempts)) }),
            })
            .where(eq(outbox.id, row.id));
          stats[dead ? "dead" : "retried"]++;
        }
      }
    });

    if (progressed) continue;
    // nothing sendable: done, unless rows are only waiting for the 25/s window
    if (globalPaced.size === 0) break;
    const wait = pacer.globalWaitMs(at().getTime());
    if (clock() - t0 + wait > budget) break;
    await sleep(wait);
    globalPaced = new Set();
  }
  stats.paced += globalPaced.size;
  return stats;
}

const defaultPacer = new Pacer();

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
  run: async ({ db, now, log }) => {
    const s = await drainQueue(db, now);
    if (s.sent + s.retried + s.dead > 0) log(`sent ${s.sent}, retry ${s.retried}, dead ${s.dead}, paced ${s.paced}`);
    return s;
  },
};
