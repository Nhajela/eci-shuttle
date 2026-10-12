import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { outbox } from "@/db/schema";
import type { DeliveryResult, OutboxJob } from "@/services/kernel";
import { type Deliverers, drainQueue, Pacer } from "./queue";

const NOW = new Date("2026-10-12T04:10:00Z");

async function add(kind: "telegram" | "push", payload: Record<string, unknown>, over: Partial<OutboxJob> = {}) {
  const [row] = await testDb()
    .insert(outbox)
    .values({ workspaceId: null, kind, payload, runAfter: NOW, ...over })
    .returning();
  return row as OutboxJob;
}
const tg = (chatId: number, over: Partial<OutboxJob> = {}) =>
  add("telegram", { chatId, html: "hi", kind: "broadcast" }, over);
const push = (over: Partial<OutboxJob> = {}) => add("push", { deviceId: crypto.randomUUID(), reason: "config" }, over);
const get = async (id: number) => (await testDb().select().from(outbox).where(eq(outbox.id, id)))[0];

/** A fake clock that only moves when the queue sleeps, plus a recording deliverer. */
function harness(result: (job: OutboxJob) => DeliveryResult = () => ({ ok: true })) {
  let t = 0;
  const delivered: OutboxJob[] = [];
  const deliver = async (_db: unknown, job: OutboxJob) => {
    delivered.push(job);
    return result(job);
  };
  const deps = {
    deliver: { telegram: deliver, push: deliver } as Deliverers,
    pacer: new Pacer(),
    clock: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
  return { deps, delivered, elapsed: () => t };
}

describe("drainQueue", () => {
  it("sends due rows and marks them sent; leaves future rows pending", async () => {
    const a = await tg(101);
    const b = await push();
    const later = await tg(102, { runAfter: new Date(NOW.getTime() + 60_000) });
    const h = harness();
    const r = await drainQueue(testDb(), NOW, h.deps);
    expect(r.sent).toBeGreaterThanOrEqual(2);
    expect(h.delivered.map((j) => j.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(h.delivered.map((j) => j.id)).not.toContain(later.id);
    expect(await get(a.id)).toMatchObject({ status: "sent", sentAt: NOW, error: null });
    expect(await get(b.id)).toMatchObject({ status: "sent", sentAt: NOW });
    expect(await get(later.id)).toMatchObject({ status: "pending", sentAt: null });
  });

  it("retry: attempts + 1 and run_after backs off; dead after the 8th attempt", async () => {
    const fresh = await push();
    const tired = await push({ attempts: 7 });
    const h = harness(() => ({ ok: false, retry: true, error: "503" }));
    await drainQueue(testDb(), NOW, h.deps);
    expect(await get(fresh.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "503",
      runAfter: new Date(NOW.getTime() + 5_000),
    });
    expect(await get(tired.id)).toMatchObject({ status: "dead", attempts: 8, error: "503" });
  });

  it("retry false marks the row dead with the error; a throwing deliverer is retried", async () => {
    const blocked = await tg(201);
    const flaky = await tg(202);
    const h = harness((j) => {
      if (j.id === flaky.id) throw new Error("ECONNRESET");
      return { ok: false, retry: false, error: "blocked" };
    });
    await drainQueue(testDb(), NOW, h.deps);
    expect(await get(blocked.id)).toMatchObject({ status: "dead", attempts: 1, error: "blocked" });
    expect(await get(flaky.id)).toMatchObject({ status: "pending", attempts: 1, error: "ECONNRESET" });
  });

  it("an unknown kind is dead without delivery", async () => {
    const odd = await add("email" as "push", {});
    const h = harness();
    await drainQueue(testDb(), NOW, h.deps);
    expect(h.delivered.map((j) => j.id)).not.toContain(odd.id);
    expect(await get(odd.id)).toMatchObject({ status: "dead" });
  });

  it("one message per chat per second: the second to the same chat waits for the next tick", async () => {
    const first = await tg(301);
    const second = await tg(301);
    const h = harness();
    await drainQueue(testDb(), NOW, h.deps);
    expect(await get(first.id)).toMatchObject({ status: "sent" });
    expect(await get(second.id)).toMatchObject({ status: "pending", attempts: 0 });
    // the next tick, 2 s later, with the same pacer
    await drainQueue(testDb(), new Date(NOW.getTime() + 2_000), h.deps);
    expect(await get(second.id)).toMatchObject({ status: "sent" });
  });

  it("a broadcast is paced at 25 sends a second and stops at the budget", async () => {
    const ids = new Set<number>();
    for (let i = 0; i < 60; i++) ids.add((await tg(1000 + i)).id);
    const h = harness();
    const r = await drainQueue(testDb(), NOW, { ...h.deps, budgetMs: 1_500 });
    // 25 at t=0, wait until t=1000, 25 more; the budget ends before a third second
    expect(r.sent).toBe(50);
    expect(h.elapsed()).toBeLessThanOrEqual(1_500);
    const pending = await testDb().select().from(outbox).where(eq(outbox.status, "pending"));
    expect(pending.filter((p) => ids.has(p.id))).toHaveLength(10);
  });

  it("push rows are not held back by Telegram pacing", async () => {
    for (let i = 0; i < 30; i++) await tg(2000 + i);
    const p = await push();
    const h = harness();
    await drainQueue(testDb(), NOW, { ...h.deps, budgetMs: 500 });
    expect(await get(p.id)).toMatchObject({ status: "sent" });
  });
});
