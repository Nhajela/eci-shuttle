/**
 * The worker process (SPEC §2b): `node worker.js` from the same image as web. Scheduler: croner (cron patterns
 * in IST, seconds resolution, no overlapping ticks). Queue: the Postgres outbox table (jobs/queue). Every job
 * except heartbeat takes a Postgres advisory lock, so a restart or a second worker never double-runs.
 */
import { hostname } from "node:os";
import { IST_TZ } from "@eci-shuttle/shared";
import { Cron } from "croner";
import { db, rawSql } from "@/db";
import { heartbeat } from "./jobs/heartbeat";
import { jobs } from "./jobs/index";
import { type RunDeps, runJob } from "./runner";

const deps: RunDeps = {
  db: db(),
  sql: rawSql(),
  workerId: `${hostname()}:${process.pid}`,
  startedAt: new Date(),
};

const crons = jobs.map(
  (job) =>
    new Cron(job.schedule, { name: job.name, timezone: IST_TZ, protect: true }, async () => {
      await runJob(job, deps);
    }),
);
console.log(`worker ${deps.workerId} started: ${jobs.map((j) => j.name).join(", ")}`);
// beat right away so /api/health is green without waiting for the first minute
void runJob(heartbeat, deps);

async function shutdown(signal: string) {
  console.log(`worker ${deps.workerId}: ${signal}, stopping`);
  for (const c of crons) c.stop();
  await rawSql().end({ timeout: 10 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
