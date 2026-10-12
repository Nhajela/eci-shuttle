import { Cron } from "croner";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import type { JobContext } from "../job";

const runNoticeLifecycle = vi.fn(async () => ({ sent: 2, unpinned: 1 }));
vi.mock("@/services/notices/notices", () => ({ runNoticeLifecycle }));

const { notices } = await import("./notices");

describe("notices job", () => {
  it("passes the tick's db and now to runNoticeLifecycle and returns its counts", async () => {
    const db = {} as Db;
    const now = new Date("2026-10-12T04:10:00Z");
    const ctx: JobContext = { db, now, workerId: "w1", startedAt: now, log: () => {} };
    await expect(notices.run(ctx)).resolves.toEqual({ sent: 2, unpinned: 1 });
    expect(runNoticeLifecycle).toHaveBeenCalledWith(db, now);
  });

  it("ticks every minute under the advisory lock, so a notice is never sent twice", () => {
    expect(notices.name).toBe("notices");
    expect(notices.lock).not.toBe(false);
    const runs = new Cron(notices.schedule, { timezone: "Asia/Kolkata", paused: true }).nextRuns(
      2,
      new Date("2026-10-12T04:10:30Z"),
    );
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-10-12T04:11:00.000Z", "2026-10-12T04:12:00.000Z"]);
  });
});
