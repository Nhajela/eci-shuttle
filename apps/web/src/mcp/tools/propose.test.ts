import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { workspaceBySlug } from "@/services/catalog/workspaces";
import { type Actor, ServiceError } from "@/services/kernel";
import { confirm, proposalWorkspace, propose } from "@/services/mcp/proposals";
import { shuttleConfirm, shuttlePropose, type ToolContext } from "./propose";

vi.mock("@/services/catalog/workspaces", () => ({ workspaceBySlug: vi.fn() }));
vi.mock("@/services/mcp/proposals", () => ({ propose: vi.fn(), confirm: vi.fn(), proposalWorkspace: vi.fn() }));

const NOW = new Date("2026-10-12T04:50:00Z"); // 10:20 IST
const db = {} as Db;
const actor: Actor = { kind: "admin", id: "p1", workspaceId: "w1", role: "ops", channel: "mcp", client: "claude.ai" };
const ctx: ToolContext = { db, now: NOW, personId: "p1", actorFor: vi.fn(async () => actor) };
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");
const change = { kind: "notice.end", noticeId: "7d1c2f6e-3a1b-4c5d-8e9f-0a1b2c3d4e5f" };

beforeEach(() => vi.clearAllMocks());

describe("shuttle_propose", () => {
  it("resolves the slug, builds the actor for it, and shows lines, warnings, code and IST expiry", async () => {
    vi.mocked(workspaceBySlug).mockResolvedValue({ id: "w1", slug: "eci" } as never);
    vi.mocked(propose).mockResolvedValue({
      code: "P-7K3Q9XWD",
      summary: "• End the notice 'Fuel stop'\nReason: back on the road",
      lines: ["End the notice 'Fuel stop'"],
      warnings: ["Riva has no shuttle 10:00–10:40"],
      expiresAt: new Date(NOW.getTime() + 600_000),
    });
    const r = await shuttlePropose(ctx, { workspace: "eci", changes: [change], reason: "back on the road" });
    expect(r.isError).toBeFalsy();
    expect(ctx.actorFor).toHaveBeenCalledWith("w1");
    expect(propose).toHaveBeenCalledWith(
      db,
      actor,
      { workspaceId: "w1", changes: [change], reason: "back on the road" },
      NOW,
    );
    const t = text(r);
    for (const s of ["End the notice 'Fuel stop'", "Riva has no shuttle 10:00–10:40", "P-7K3Q9XWD", "10:30 IST"])
      expect(t).toContain(s);
  });

  it("unknown workspace and invalid input come back as tool errors, nothing proposed", async () => {
    vi.mocked(workspaceBySlug).mockResolvedValue(null);
    const r = await shuttlePropose(ctx, { workspace: "nope", changes: [change] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("nope");
    const bad = await shuttlePropose(ctx, { workspace: "eci", changes: [] });
    expect(bad.isError).toBe(true);
    expect(propose).not.toHaveBeenCalled();
  });
});

describe("shuttle_confirm", () => {
  it("builds the actor for the proposal's workspace and reports what landed", async () => {
    vi.mocked(proposalWorkspace).mockResolvedValue("w1");
    vi.mocked(confirm).mockResolvedValue({
      proposalId: "P-7K3Q9XWD",
      summary: "• End the notice 'Fuel stop'",
      results: [{ kind: "notice.end", result: {} }],
    });
    const r = await shuttleConfirm(ctx, { code: "P-7K3Q9XWD" });
    expect(proposalWorkspace).toHaveBeenCalledWith(db, "p1", "P-7K3Q9XWD");
    expect(confirm).toHaveBeenCalledWith(db, actor, { code: "P-7K3Q9XWD" }, NOW);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("End the notice 'Fuel stop'");
  });

  it("hands over what the person needs from results: pairing code + QR link, new objects' names and ids", async () => {
    vi.mocked(proposalWorkspace).mockResolvedValue("w1");
    vi.mocked(confirm).mockResolvedValue({
      proposalId: "P-7K3Q9XWD",
      summary: "• Make a pairing code\n• Add spot 'Circle'\n• End the notice 'Fuel stop'",
      results: [
        {
          kind: "pairing_code.create",
          result: {
            code: "482913",
            qrUrl: "https://x.test/pair/482913",
            expiresAt: new Date(NOW.getTime() + 1_800_000),
          },
        },
        { kind: "spot.create", result: { id: "s-123", name: "Circle" } },
        { kind: "notice.end", result: { id: "n-1", title: "Fuel stop" } },
      ],
    });
    const t = text(await shuttleConfirm(ctx, { code: "P-7K3Q9XWD" }));
    for (const s of ["482913", "https://x.test/pair/482913", "10:50 IST", "Circle", "s-123"]) expect(t).toContain(s);
    expect(t).not.toContain("n-1");
  });

  it("a stale proposal is a tool error telling the model to propose again", async () => {
    vi.mocked(proposalWorkspace).mockResolvedValue("w1");
    vi.mocked(confirm).mockRejectedValue(
      new ServiceError("STALE_VERSION", "Something changed since this was proposed."),
    );
    const r = await shuttleConfirm(ctx, { code: "P-7K3Q9XWD" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("shuttle_propose");
  });

  it("unexpected errors are not swallowed", async () => {
    vi.mocked(proposalWorkspace).mockRejectedValue(new Error("db down"));
    await expect(shuttleConfirm(ctx, { code: "P-7K3Q9XWD" })).rejects.toThrow("db down");
  });
});
