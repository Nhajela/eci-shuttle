import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rawSql } from "@/db";
import { workerHeartbeat } from "@/db/schema";
import type { Job } from "./job";
import { heartbeat } from "./jobs/heartbeat";
import { withAdvisoryLock } from "./lock";
import { type RunDeps, runJob } from "./runner";

const NOW = new Date("2026-10-12T04:10:00Z");
const logs: string[] = [];
const deps = (workerId = `w-${Math.random()}`): RunDeps => ({
  db: testDb(),
  sql: rawSql(),
  workerId,
  startedAt: new Date("2026-10-12T04:00:00Z"),
  now: () => NOW,
  log: (m) => logs.push(m),
});
const job = (over: Partial<Job>): Job => ({
  name: `j-${Math.random()}`,
  schedule: "* * * * *",
  run: async () => "done",
  ...over,
});

describe("runJob", () => {
  it("runs the job with a context carrying now, and reports ok", async () => {
    let seen: Date | null = null;
    const r = await runJob(
      job({
        run: async (ctx) => {
          seen = ctx.now;
        },
      }),
      deps(),
    );
    expect(r.status).toBe("ok");
    expect(seen).toEqual(NOW);
  });

  it("the heartbeat job writes this worker's beat", async () => {
    const d = deps("hb-worker");
    expect((await runJob(heartbeat, d)).status).toBe("ok");
    const [row] = await testDb().select().from(workerHeartbeat).where(eq(workerHeartbeat.workerId, "hb-worker"));
    expect(row).toMatchObject({ beatAt: NOW, startedAt: d.startedAt });
  });

  it("skips when another worker holds the job's lock", async () => {
    const j = job({});
    const r = await withAdvisoryLock(rawSql(), `job:${j.name}`, () => runJob(j, deps()));
    expect(r).toEqual({ ran: true, value: expect.objectContaining({ status: "skipped" }) });
  });

  it("lock: false runs even while the lock is held", async () => {
    const j = job({ lock: false });
    const r = await withAdvisoryLock(rawSql(), `job:${j.name}`, () => runJob(j, deps()));
    expect(r).toEqual({ ran: true, value: expect.objectContaining({ status: "ok" }) });
  });

  it("a failing job is reported and logged, never thrown", async () => {
    const r = await runJob(
      job({
        name: "explodes",
        run: async () => {
          throw new Error("kaboom");
        },
      }),
      deps(),
    );
    expect(r).toMatchObject({ status: "failed", error: "kaboom" });
    expect(logs.some((l) => l.includes("explodes") && l.includes("kaboom"))).toBe(true);
  });
});
