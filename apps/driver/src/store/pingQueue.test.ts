import type { Ping } from "@eci-shuttle/shared/contracts";
import { describe, expect, it } from "vitest";
import { memoryKV } from "./kv";
import { createPingQueue, MAX_AGE_MS } from "./pingQueue";

const H = 3_600_000;
const NOW = 100 * H;
const ping = (recordedAt: number): Ping => ({
  recordedAt,
  lat: 15.6,
  lng: 73.7,
  accuracy: 5,
  speed: null,
  heading: null,
  battery: 80,
});

describe("ping queue (SPEC §4: queued on disk, uploaded in batches)", () => {
  it("starts empty", async () => {
    const q = createPingQueue(memoryKV());
    expect(await q.size()).toBe(0);
    expect(await q.batch(NOW)).toEqual([]);
  });

  it("returns the oldest pings first, at most `max` per batch", async () => {
    const q = createPingQueue(memoryKV());
    await q.push([ping(NOW - 3), ping(NOW - 1), ping(NOW - 2)], NOW);
    expect((await q.batch(NOW, 2)).map((p) => p.recordedAt)).toEqual([NOW - 3, NOW - 2]);
  });

  it("drops a ping only once its batch is acked", async () => {
    const q = createPingQueue(memoryKV());
    await q.push([ping(NOW - 3), ping(NOW - 2), ping(NOW - 1)], NOW);
    const b = await q.batch(NOW, 2);
    expect(await q.size()).toBe(3);
    await q.ack(b);
    expect((await q.batch(NOW)).map((p) => p.recordedAt)).toEqual([NOW - 1]);
  });

  it("keeps pings pushed while a batch was in flight", async () => {
    const q = createPingQueue(memoryKV());
    await q.push([ping(NOW - 3)], NOW);
    const b = await q.batch(NOW);
    await q.push([ping(NOW - 1)], NOW);
    await q.ack(b);
    expect((await q.batch(NOW)).map((p) => p.recordedAt)).toEqual([NOW - 1]);
  });

  it("caps the queue at 24h: older pings are dropped", async () => {
    const q = createPingQueue(memoryKV());
    await q.push([ping(NOW - MAX_AGE_MS - 1), ping(NOW - MAX_AGE_MS), ping(NOW - H)], NOW);
    expect((await q.batch(NOW)).map((p) => p.recordedAt)).toEqual([NOW - MAX_AGE_MS, NOW - H]);
    expect(MAX_AGE_MS).toBe(24 * H);
    // and pings age out while waiting, too
    expect((await q.batch(NOW + 2 * H)).map((p) => p.recordedAt)).toEqual([NOW - H]);
  });

  it("dedupes on recordedAt, like the server", async () => {
    const q = createPingQueue(memoryKV());
    await q.push([ping(NOW - 1)], NOW);
    await q.push([ping(NOW - 1), ping(NOW - 2)], NOW);
    expect(await q.size()).toBe(2);
  });

  it("persists across restarts", async () => {
    const kv = memoryKV();
    await createPingQueue(kv).push([ping(NOW - 1)], NOW);
    expect(await createPingQueue(kv).size()).toBe(1);
  });

  it("concurrent pushes and acks don't lose pings", async () => {
    const q = createPingQueue(memoryKV());
    await q.push([ping(NOW - 10)], NOW);
    const b = await q.batch(NOW);
    await Promise.all([q.push([ping(NOW - 2)], NOW), q.ack(b), q.push([ping(NOW - 1)], NOW)]);
    expect((await q.batch(NOW)).map((p) => p.recordedAt)).toEqual([NOW - 2, NOW - 1]);
  });

  it("treats a corrupt file as empty instead of crashing, and recovers", async () => {
    const kv = memoryKV();
    const q = createPingQueue(kv);
    await q.push([ping(NOW - 1)], NOW);
    for (const k of Object.keys(kv.dump())) await kv.set(k, "[{oops");
    expect(await q.size()).toBe(0);
    await q.push([ping(NOW - 2)], NOW);
    expect(await q.size()).toBe(1);
  });

  it("skips invalid pings from disk but keeps the valid ones", async () => {
    const kv = memoryKV();
    const q = createPingQueue(kv);
    await q.push([ping(NOW - 1)], NOW);
    const [k] = Object.keys(kv.dump());
    await kv.set(k, JSON.stringify([ping(NOW - 2), { recordedAt: "x" }, ping(NOW - 1)]));
    expect(await q.size()).toBe(2);
  });
});
