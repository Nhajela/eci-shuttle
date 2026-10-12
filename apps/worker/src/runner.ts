import type postgres from "postgres";
import type { Db } from "@/db";
import type { Job, JobContext } from "./job";
import { withAdvisoryLock } from "./lock";

export type RunDeps = {
  db: Db;
  sql: postgres.Sql;
  workerId: string;
  startedAt: Date;
  now?: () => Date;
  log?: (msg: string) => void;
};

export type RunResult = { job: string; status: "ok" | "skipped" | "failed"; ms: number; error?: string };

/** One tick of a job: lock (unless lock: false), run with a fresh context, catch and log any error. */
export async function runJob(job: Job, deps: RunDeps): Promise<RunResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const ctx: JobContext = {
    db: deps.db,
    now: deps.now?.() ?? new Date(),
    workerId: deps.workerId,
    startedAt: deps.startedAt,
    log: (m) => log(`[${job.name}] ${m}`),
  };
  const t0 = Date.now();
  try {
    const ran =
      job.lock === false
        ? { ran: true as const, value: await job.run(ctx) }
        : await withAdvisoryLock(deps.sql, `job:${job.name}`, () => job.run(ctx));
    return { job: job.name, status: ran.ran ? "ok" : "skipped", ms: Date.now() - t0 };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`[${job.name}] failed: ${error}`);
    return { job: job.name, status: "failed", ms: Date.now() - t0, error };
  }
}
