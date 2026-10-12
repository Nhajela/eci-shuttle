/** svc-health: worker heartbeat and /api/health (SPEC §2b Uptime). Infra rows, not audited. */
import { max } from "drizzle-orm";
import type { Db } from "@/db";
import { workerHeartbeat } from "@/db/schema";

/** /api/health fails when the newest worker heartbeat is older than this. */
export const HEARTBEAT_MAX_AGE_MS = 3 * 60_000;

export type Health = {
  /** db reachable and a worker beat within HEARTBEAT_MAX_AGE_MS */
  ok: boolean;
  db: boolean;
  /** newest beat_at of any worker, ISO */
  heartbeatAt: string | null;
  heartbeatAgeS: number | null;
};

/** Upsert this worker's worker_heartbeat row (the worker `heartbeat` job, every minute). */
export async function recordHeartbeat(
  db: Db,
  input: { workerId: string; startedAt: Date; info?: Record<string, unknown> },
  now: Date,
): Promise<void> {
  const row = { beatAt: now, startedAt: input.startedAt, info: input.info ?? null };
  await db
    .insert(workerHeartbeat)
    .values({ workerId: input.workerId, ...row })
    .onConflictDoUpdate({ target: workerHeartbeat.workerId, set: row });
}

/** Never throws: an unreachable database is `{ ok: false, db: false }`. */
export async function checkHealth(db: Db, now: Date): Promise<Health> {
  let newest: Date | null;
  try {
    const [r] = await db.select({ at: max(workerHeartbeat.beatAt) }).from(workerHeartbeat);
    newest = r?.at ?? null;
  } catch {
    return { ok: false, db: false, heartbeatAt: null, heartbeatAgeS: null };
  }
  if (!newest) return { ok: false, db: true, heartbeatAt: null, heartbeatAgeS: null };
  const ageMs = now.getTime() - newest.getTime();
  return {
    ok: ageMs <= HEARTBEAT_MAX_AGE_MS,
    db: true,
    heartbeatAt: newest.toISOString(),
    heartbeatAgeS: Math.round(ageMs / 1000),
  };
}
