/**
 * A scheduled worker job (SPEC §2b). One file per job in ./jobs, registered in ./jobs/index.ts.
 * Jobs are thin: they call service functions (apps/web/src/services) with `ctx.now`, never write SQL themselves.
 */
import type { Db } from "@/db";

export type JobContext = {
  db: Db;
  /** the tick's time: pass it to every service call (pure functions take now) */
  now: Date;
  workerId: string;
  /** when this worker process started */
  startedAt: Date;
  log: (msg: string) => void;
};

export type Job = {
  /** kebab-case, unique; the advisory lock is `job:<name>` */
  name: string;
  /**
   * croner pattern evaluated in IST (Asia/Kolkata): 5 fields = minute resolution, 6 fields = with seconds
   * ("*\/15 * * * * *" = every 15 s). Ticks never overlap (croner `protect`).
   */
  schedule: string;
  /**
   * Default true: hold the Postgres advisory lock `job:<name>` while running, so a second worker (or a restart
   * overlapping the old process) skips the tick instead of double-running or double-sending.
   */
  lock?: boolean;
  run: (ctx: JobContext) => Promise<unknown>;
};
