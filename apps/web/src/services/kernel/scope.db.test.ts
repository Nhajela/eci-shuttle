import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
import { spots } from "@/db/schema";
import { checkVersion, findInWorkspace, getInWorkspace, readable } from "./scope";

const db = () => testDb();
const spot = async (workspaceId: string) =>
  (
    await db()
      .insert(spots)
      .values({ workspaceId, name: "Circle", shortName: "Circle", lat: 15.6, lng: 73.7 })
      .returning()
  )[0];

describe("workspace scoping", () => {
  it("finds a row only inside its own workspace", async () => {
    const a = await makeWorkspace(db());
    const b = await makeWorkspace(db());
    const s = await spot(a.id);
    expect((await findInWorkspace(db(), spots, a.id, s.id))?.name).toBe("Circle");
    expect(await findInWorkspace(db(), spots, b.id, s.id)).toBeNull();
    await expect(getInWorkspace(db(), spots, b.id, s.id, "spot")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getInWorkspace(db(), spots, a.id, s.id, "spot")).id).toBe(s.id);
  });

  it("getInWorkspace can lock the row for update inside a transaction", async () => {
    const a = await makeWorkspace(db());
    const s = await spot(a.id);
    await db().transaction(async (tx) => {
      expect((await getInWorkspace(tx, spots, a.id, s.id, "spot", { forUpdate: true })).id).toBe(s.id);
    });
  });

  it("readable() requires at least viewer in that workspace", async () => {
    const a = await makeWorkspace(db());
    const b = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), a.id, "viewer");
    expect(() => readable(actor, a.id)).not.toThrow();
    expect(() => readable(actor, b.id)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});

describe("checkVersion", () => {
  it("passes when no version is expected or it matches", () => {
    expect(() => checkVersion({ version: 3 }, undefined, "spot")).not.toThrow();
    expect(() => checkVersion({ version: 3 }, 3, "spot")).not.toThrow();
  });

  it("throws STALE_VERSION on mismatch", () => {
    expect(() => checkVersion({ version: 4 }, 3, "spot")).toThrow(
      expect.objectContaining({ code: "STALE_VERSION", details: { entity: "spot", expected: 3, actual: 4 } }),
    );
  });
});
