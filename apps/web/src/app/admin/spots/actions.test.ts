import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel";

const actor = { kind: "admin", id: "p1", workspaceId: "ws1", role: "ops", channel: "web" };
const requireAdmin = vi.fn(async (_: unknown) => ({ actor, workspace: { id: "ws1", slug: "live" } }));
const createSpot = vi.fn();
const updateSpot = vi.fn();
const archiveSpot = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/session", () => ({ requireAdmin: (o: unknown) => requireAdmin(o) }));
vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/services/catalog/spots", () => ({
  createSpot: (...a: unknown[]) => createSpot(...a),
  updateSpot: (...a: unknown[]) => updateSpot(...a),
  archiveSpot: (...a: unknown[]) => archiveSpot(...a),
}));

const { archiveSpotAction, saveSpotAction } = await import("./actions");

const fields = { name: "Riva", shortName: "Riva", lat: 15.66, lng: 73.71, radiusM: 80, notes: null };

beforeEach(() => vi.clearAllMocks());

describe("saveSpotAction", () => {
  it("creates a spot as ops in the ?w= workspace", async () => {
    createSpot.mockResolvedValue({ id: "s1" });
    const r = await saveSpotAction("live", { ...fields });
    expect(requireAdmin).toHaveBeenCalledWith({ w: "live", minRole: "ops" });
    expect(createSpot).toHaveBeenCalledWith("DB", actor, { ...fields, workspaceId: "ws1" });
    expect(updateSpot).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/spots");
  });

  it("updates with the version it edited", async () => {
    updateSpot.mockResolvedValue({ id: "s1" });
    await saveSpotAction("live", { ...fields, spotId: "s1", version: 3 });
    expect(updateSpot).toHaveBeenCalledWith("DB", actor, { ...fields, spotId: "s1", version: 3, workspaceId: "ws1" });
    expect(createSpot).not.toHaveBeenCalled();
  });

  it("returns the service's plain-English message instead of throwing", async () => {
    updateSpot.mockRejectedValue(new ServiceError("STALE_VERSION", "This spot was changed by someone else."));
    const r = await saveSpotAction("live", { ...fields, spotId: "s1", version: 1 });
    expect(r).toEqual({ ok: false, error: "This spot was changed by someone else." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides unexpected errors behind a generic message", async () => {
    createSpot.mockRejectedValue(new Error("db exploded"));
    const r = await saveSpotAction("live", fields);
    expect(r).toEqual({ ok: false, error: "Something went wrong. Try again." });
  });
});

describe("archiveSpotAction", () => {
  it("archives as ops", async () => {
    archiveSpot.mockResolvedValue({ id: "s1" });
    const r = await archiveSpotAction("live", { spotId: "s1", version: 2 });
    expect(requireAdmin).toHaveBeenCalledWith({ w: "live", minRole: "ops" });
    expect(archiveSpot).toHaveBeenCalledWith("DB", actor, { spotId: "s1", version: 2, workspaceId: "ws1" });
    expect(r).toEqual({ ok: true });
  });

  it("passes on a CONFLICT (spot used by a route)", async () => {
    archiveSpot.mockRejectedValue(new ServiceError("CONFLICT", "Riva is used by Loop."));
    expect(await archiveSpotAction("live", { spotId: "s1" })).toEqual({ ok: false, error: "Riva is used by Loop." });
  });
});
