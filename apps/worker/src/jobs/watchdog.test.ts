import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { runWatchdog } from "@/services/alerts/watchdog";
import type { JobContext } from "../job";
import { watchdog } from "./watchdog";

vi.mock("@/services/alerts/watchdog", () => ({ runWatchdog: vi.fn() }));

const db = {} as Db;
const now = new Date("2026-10-15T04:30:00Z");
const ctx: JobContext = { db, now, workerId: "w1", startedAt: now, log: () => {} };

describe("watchdog job", () => {
  beforeEach(() => vi.mocked(runWatchdog).mockReset());

  it("runs every minute under its advisory lock", () => {
    expect(watchdog.name).toBe("watchdog");
    expect(watchdog.schedule).toBe("* * * * *");
    expect(watchdog.lock).not.toBe(false);
  });

  it("calls alerts.runWatchdog with the tick's db and now, and returns its result", async () => {
    const result = { workspaces: 2, problems: 3, alerted: 1 };
    vi.mocked(runWatchdog).mockResolvedValue(result);
    await expect(watchdog.run(ctx)).resolves.toEqual(result);
    expect(runWatchdog).toHaveBeenCalledExactlyOnceWith(db, now);
  });
});
