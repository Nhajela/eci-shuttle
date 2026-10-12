import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { outbox } from "@/db/schema";
import { enqueue } from "./outbox";

const db = () => testDb();

describe("enqueue", () => {
  it("queues a pending job, due now by default", async () => {
    const ws = await makeWorkspace(db());
    const job = await enqueue(db(), {
      workspaceId: ws.id,
      kind: "push",
      payload: { deviceId: "d1", reason: "config" },
    });
    expect(job).toMatchObject({
      status: "pending",
      attempts: 0,
      kind: "push",
      payload: { deviceId: "d1", reason: "config" },
    });
  });

  it("is idempotent on dedupeKey (a restart never double-sends)", async () => {
    const ws = await makeWorkspace(db());
    const key = `notice:${ws.id}:sent`;
    const first = await enqueue(db(), {
      workspaceId: ws.id,
      kind: "telegram",
      payload: { chatId: 1, html: "one", kind: "notice" },
      dedupeKey: key,
    });
    const again = await enqueue(db(), {
      workspaceId: ws.id,
      kind: "telegram",
      payload: { chatId: 1, html: "two", kind: "notice" },
      dedupeKey: key,
    });
    expect(first).not.toBeNull();
    expect(again).toBeNull();
    const rows = await db().select().from(outbox).where(eq(outbox.dedupeKey, key));
    expect(rows.map((r) => r.payload.html)).toEqual(["one"]);
  });

  it("rolls back with the transaction it was queued in", async () => {
    const ws = await makeWorkspace(db());
    await expect(
      db().transaction(async (tx) => {
        await enqueue(tx, { workspaceId: ws.id, kind: "push", payload: { deviceId: "d1", reason: "x" } });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db().select().from(outbox).where(eq(outbox.workspaceId, ws.id))).toEqual([]);
  });
});
