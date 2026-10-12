import { IST_TZ } from "@eci-shuttle/shared";
import { Cron } from "croner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { runArrivalAlerts } from "@/services/subscriptions/subscriptions";
import type { JobContext } from "../job";
import { arrivalAlerts } from "./arrival-alerts";

vi.mock("@/services/subscriptions/subscriptions", () => ({ runArrivalAlerts: vi.fn() }));
const run = vi.mocked(runArrivalAlerts);

const NOW = new Date("2026-10-12T04:10:07Z");
const db = {} as Db;
const ctx: JobContext = { db, now: NOW, workerId: "w1", startedAt: NOW, log: () => {} };

describe("arrival-alerts job", () => {
  beforeEach(() => run.mockReset());

  it("ticks every 15 s, IST", () => {
    const next = new Cron(arrivalAlerts.schedule, { timezone: IST_TZ, paused: true }).nextRuns(4, NOW);
    expect(next.map((d) => d.toISOString())).toEqual([
      "2026-10-12T04:10:15.000Z",
      "2026-10-12T04:10:30.000Z",
      "2026-10-12T04:10:45.000Z",
      "2026-10-12T04:11:00.000Z",
    ]);
  });

  it("holds the advisory lock so two workers never double-send", () => {
    expect(arrivalAlerts.name).toBe("arrival-alerts");
    expect(arrivalAlerts.lock).not.toBe(false);
  });

  it("fires and expires across all workspaces at the tick's now", async () => {
    run.mockResolvedValue({ fired: 2, expired: 1 });
    await expect(arrivalAlerts.run(ctx)).resolves.toEqual({ fired: 2, expired: 1 });
    expect(run).toHaveBeenCalledExactlyOnceWith(db, {}, NOW);
  });
});
