import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { devices, outbox } from "@/db/schema";
import { deliverTelegram } from "@/services/bot/deliver";
import { deliverPush } from "@/services/devices/push";
import { type DeliveryResult, enqueue, type OutboxJob } from "@/services/kernel";
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

/** How long a claimed row stays invisible to other ticks; a crash mid-tick re-sends unsent rows after this. */
export const LEASE_MS = 120_000;

/**
 * Drain due outbox rows until nothing is due or the budget is spent. A short transaction claims a batch with
 * FOR UPDATE SKIP LOCKED and leases it (run_after = now + 2 min); then each row is delivered with `db` and its result
 * written at once, so a crash or a failed write re-sends at most the row in flight. Telegram rows over the pacing
 * limits get their original run_after back; push rows are never held back by them.
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
  // rows handed back this tick, so the next claim does not pick them up again
  const released = new Set<number>();
  const release = (row: OutboxJob) => {
    released.add(row.id);
    return db.update(outbox).set({ runAfter: row.runAfter }).where(eq(outbox.id, row.id));
  };

  while (!outOfTime()) {
    const skip = [...released];
    const rows = await db.transaction(async (tx) => {
      const due = await tx
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
      if (due.length) {
        const lease = new Date(at().getTime() + LEASE_MS);
        await tx
          .update(outbox)
          .set({ runAfter: lease })
          .where(
            inArray(
              outbox.id,
              due.map((r) => r.id),
            ),
          );
      }
      return due; // original run_after values, for release()
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      if (outOfTime()) {
        await release(row);
        continue;
      }
      if (row.kind === "telegram") {
        const chatId = Number((row.payload as { chatId?: unknown }).chatId);
        const wait = pacer.globalWaitMs(at().getTime());
        if (!pacer.chatReady(chatId, at().getTime()) || clock() - t0 + wait > budget) {
          await release(row);
          stats.paced++;
          continue;
        }
        if (wait > 0) await sleep(wait);
        pacer.record(chatId, at().getTime());
      }
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
        await db.update(outbox).set({ status: "sent", sentAt: done, error: null }).where(eq(outbox.id, row.id));
        stats.sent++;
      } else {
        const attempts = row.attempts + 1;
        const dead = !r.retry || attempts >= MAX_ATTEMPTS;
        await db
          .update(outbox)
          .set({
            attempts,
            error: r.error,
            ...(dead ? { status: "dead" as const } : { runAfter: new Date(done.getTime() + backoffMs(row.attempts)) }),
          })
          .where(eq(outbox.id, row.id));
        stats[dead ? "dead" : "retried"]++;
      }
    }
  }
  return stats;
}

/** Re-push is checked about once a minute; one re-push per device per config version per 10 min. */
const REPUSH_BUCKET_MS = 600_000;
const SYNC_GRACE_MS = 120_000;

/**
 * Phones behind on config (SPEC §2b): Expo may accept a push the phone never acts on (Doze, app swiped away), so
 * queue another "sync now" for every live phone whose reported config is behind and that has not synced for 2 min.
 */
export async function repushBehind(db: Db, now: Date) {
  const behind = await db
    .select({ id: devices.id, workspaceId: devices.workspaceId, configVersion: devices.configVersion })
    .from(devices)
    .where(
      and(
        isNull(devices.revokedAt),
        isNotNull(devices.pushToken),
        sql`${devices.reportedConfigVersion} is distinct from ${devices.configVersion}`,
        or(isNull(devices.lastSyncAt), lt(devices.lastSyncAt, new Date(now.getTime() - SYNC_GRACE_MS))),
      ),
    );
  const bucket = Math.floor(now.getTime() / REPUSH_BUCKET_MS);
  let queued = 0;
  for (const d of behind) {
    const job = await enqueue(db, {
      kind: "push",
      workspaceId: d.workspaceId,
      payload: { deviceId: d.id, reason: "config_behind" },
      dedupeKey: `repush:${d.id}:${d.configVersion}:${bucket}`,
      runAfter: now,
    });
    if (job) queued++;
  }
  return queued;
}

const defaultPacer = new Pacer();

/**
 * Every 2 s, draining until nothing is due or ~1.5 s passed (SPEC §2b "continuous"): the outbox is the queue
 * (no queue library). Claim due rows (status pending, run_after ≤ now) with `FOR UPDATE SKIP LOCKED` in small
 * batches, deliver with bot/deliver.deliverTelegram (kind telegram) or devices/push.deliverPush (kind push), then:
 * ok → status sent, sent_at; retry → attempts+1, run_after = now + backoff (5 s · 2^attempts, max 10 min), dead
 * after 8 attempts; retry false → dead with the error. Pacing: ≤ 25 Telegram sends/s overall and ≤ 1/s per chat
 * (Telegram limits); paced broadcasts just stay pending for the next tick. About once a minute it also
 * re-pushes phones still behind on config (repushBehind). Outbox status columns are bookkeeping,
 * not audited.
 */
export const queue: Job = {
  name: "queue",
  schedule: "*/2 * * * * *",
  run: async ({ db, now, log }) => {
    // about once a minute (the tick is every 2 s)
    const repushed = now.getSeconds() < 2 ? await repushBehind(db, now) : 0;
    const s = await drainQueue(db, now);
    if (repushed) log(`re-pushed ${repushed} phones behind on config`);
    if (s.sent + s.retried + s.dead > 0) log(`sent ${s.sent}, retry ${s.retried}, dead ${s.dead}, paced ${s.paced}`);
    return s;
  },
};
