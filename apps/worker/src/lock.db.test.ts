import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rawSql } from "@/db";
import { withAdvisoryLock } from "./lock";

const name = () => `test:${randomUUID()}`;

describe("withAdvisoryLock", () => {
  it("runs fn and returns its value", async () => {
    expect(await withAdvisoryLock(rawSql(), name(), async () => 42)).toEqual({ ran: true, value: 42 });
  });

  it("a second holder is skipped while the first runs, and can take it afterwards", async () => {
    const n = name();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = withAdvisoryLock(rawSql(), n, () => gate.then(() => "first"));
    await new Promise((r) => setTimeout(r, 50)); // let the first take the lock
    expect(await withAdvisoryLock(rawSql(), n, async () => "second")).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, value: "first" });
    expect(await withAdvisoryLock(rawSql(), n, async () => "third")).toEqual({ ran: true, value: "third" });
  });

  it("different names don't block each other", async () => {
    const a = name();
    const b = name();
    const r = await withAdvisoryLock(rawSql(), a, () => withAdvisoryLock(rawSql(), b, async () => "both"));
    expect(r).toEqual({ ran: true, value: { ran: true, value: "both" } });
  });

  it("releases the lock when fn throws, and rethrows", async () => {
    const n = name();
    await expect(
      withAdvisoryLock(rawSql(), n, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withAdvisoryLock(rawSql(), n, async () => "again")).toEqual({ ran: true, value: "again" });
  });
});
