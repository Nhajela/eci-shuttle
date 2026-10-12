import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
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
      sendDigest: async (_d, wsId) => {
        calls.push(`digest:${wsId}`);
        return 1;
      },
    });

    expect(calls.filter((c) => c.endsWith(ok.id))).toEqual([`recompute:${ok.id}`, `digest:${ok.id}`]);
    // the digest still goes out (yesterday's insights) when recompute fails
    expect(calls.filter((c) => c.endsWith(bad.id))).toEqual([`recompute:${bad.id}`, `digest:${bad.id}`]);
    expect(r.failed).toBe(1);
    expect(logs.some((l) => l.includes(bad.slug) && l.includes("bad stats"))).toBe(true);
  });
});
