import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { routes, spots } from "@/db/schema";
import type { JobContext } from "../job";
import { runLearning } from "./learning";

const NOW = new Date("2026-10-12T21:00:00Z");

describe("runLearning", () => {
  it("recomputes then sends the digest for every workspace; one failing workspace never stops the others", async () => {
    const db = testDb();
    const ok = await makeWorkspace(db);
    const bad = await makeWorkspace(db);
    const calls: string[] = [];
    const logs: string[] = [];
    const ctx: JobContext = { db, now: NOW, workerId: "w", startedAt: NOW, log: (m) => logs.push(m) };

    const r = await runLearning(ctx, {
      recomputeAll: async (d, wsId, now) => {
        expect([d, now]).toEqual([db, NOW]);
        calls.push(`recompute:${wsId}`);
        if (wsId === bad.id) throw new Error("bad stats");
        return { suggestions: 0 };
      },
      recomputeDeadZones: async (_d, wsId) => {
        calls.push(`deadzones:${wsId}`);
        if (wsId === bad.id) throw new Error("bad zones");
        return { detected: 0 };
      },
      sendDigest: async (_d, wsId) => {
        calls.push(`digest:${wsId}`);
        return 1;
      },
    });

    expect(calls.filter((c) => c.endsWith(ok.id))).toEqual([
      `recompute:${ok.id}`,
      `deadzones:${ok.id}`,
      `digest:${ok.id}`,
    ]);
    // dead-zone detection and the digest (yesterday's insights) still run when an earlier step fails
    expect(calls.filter((c) => c.endsWith(bad.id))).toEqual([
      `recompute:${bad.id}`,
      `deadzones:${bad.id}`,
      `digest:${bad.id}`,
    ]);
    expect(r.failed).toBe(2);
    expect(logs.some((l) => l.includes(bad.slug) && l.includes("bad stats"))).toBe(true);
    expect(logs.some((l) => l.includes(bad.slug) && l.includes("bad zones"))).toBe(true);
  });

  it("writes the detected dead zones to the database (stale detections cleared, manual kept)", async () => {
    const db = testDb();
    const ws = await makeWorkspace(db);
    const [a, b] = await db
      .insert(spots)
      .values([
        { workspaceId: ws.id, name: "A", shortName: "A", lat: 15.6, lng: 73.7 },
        { workspaceId: ws.id, name: "B", shortName: "B", lat: 15.61, lng: 73.7 },
      ])
      .returning();
    const [route] = await db
      .insert(routes)
      .values({
        workspaceId: ws.id,
        name: "R",
        spotIds: [(a as { id: string }).id, (b as { id: string }).id, (a as { id: string }).id],
        noSignalLegs: [
          { legIndex: 0, source: "manual" },
          { legIndex: 1, source: "detected", startAlongM: 1, endAlongM: 500, trips: 3, days: 2 },
        ],
      })
      .returning();
    const ctx: JobContext = { db, now: NOW, workerId: "w", startedAt: NOW, log: () => {} };
    const r = await runLearning(ctx, { recomputeAll: async () => ({ suggestions: 0 }), sendDigest: async () => 0 });
    expect(r.failed).toBe(0);
    const [row] = await db
      .select()
      .from(routes)
      .where(eq(routes.id, (route as { id: string }).id));
    expect(row?.noSignalLegs).toEqual([{ legIndex: 0, source: "manual" }]);
  });
});
