import { testDb } from "@tests/helpers/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { workerHeartbeat } from "@/db/schema";
import { checkHealth, recordHeartbeat } from "./health";

const db = () => testDb();
const NOW = new Date("2026-10-12T04:10:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// worker_heartbeat is global; files in one worker run one at a time, so clearing it per test is safe
beforeEach(async () => {
  await db().delete(workerHeartbeat);
});

describe("recordHeartbeat", () => {
  it("upserts one row per worker id, moving beat_at", async () => {
    await recordHeartbeat(db(), { workerId: "w1", startedAt: ago(60_000) }, ago(30_000));
    await recordHeartbeat(db(), { workerId: "w1", startedAt: ago(60_000), info: { jobs: 8 } }, NOW);
    const rows = await db().select().from(workerHeartbeat);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workerId: "w1", beatAt: NOW, startedAt: ago(60_000), info: { jobs: 8 } });
  });
});

describe("checkHealth", () => {
  it("no heartbeat yet → not ok, db ok", async () => {
    expect(await checkHealth(db(), NOW)).toEqual({ ok: false, db: true, heartbeatAt: null, heartbeatAgeS: null });
  });

  it("newest beat under 3 min old → ok", async () => {
    await recordHeartbeat(db(), { workerId: "old", startedAt: ago(3_600_000) }, ago(3_600_000));
    await recordHeartbeat(db(), { workerId: "new", startedAt: ago(120_000) }, ago(170_000));
    const h = await checkHealth(db(), NOW);
    expect(h).toMatchObject({ ok: true, db: true, heartbeatAgeS: 170 });
    expect(h.heartbeatAt).toBe(ago(170_000).toISOString());
  });

  it("newest beat over 3 min old → not ok", async () => {
    await recordHeartbeat(db(), { workerId: "w1", startedAt: ago(600_000) }, ago(181_000));
    expect(await checkHealth(db(), NOW)).toMatchObject({ ok: false, db: true, heartbeatAgeS: 181 });
  });

  it("database unreachable → not ok, db false (never throws)", async () => {
    const dead = createDb("postgres://postgres@127.0.0.1:1/none", { max: 1 });
    try {
      expect(await checkHealth(dead.db, NOW)).toEqual({ ok: false, db: false, heartbeatAt: null, heartbeatAgeS: null });
    } finally {
      await dead.close();
    }
  });
});
