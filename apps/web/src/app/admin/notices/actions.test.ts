import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel";

const actor = { kind: "admin", id: "p1", workspaceId: "ws1", role: "ops" };
const session = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
const svc = vi.hoisted(() => ({ createNotice: vi.fn(), endNotice: vi.fn(), updateNotice: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => session);
const ws = vi.hoisted(() => ({ setWorkspaceInfo: vi.fn() }));
vi.mock("@/services/notices/notices", () => svc);
vi.mock("@/services/catalog/workspaces", () => ws);
vi.mock("next/cache", () => cache);
vi.mock("@/db", () => ({ db: () => "DB" }));

const { createNoticeAction, endNoticeAction, pinNoticeAction, setInfoAction } = await import("./actions");

beforeEach(() => {
  vi.clearAllMocks();
  session.requireAdmin.mockResolvedValue({ workspace: { id: "ws1" }, actor });
});

describe("notice actions", () => {
  it("create needs ops in the chosen workspace and passes the form through", async () => {
    const form = { text: "Side gate", placements: ["everywhere" as const] };
    expect(await createNoticeAction("riva", form)).toEqual({ ok: true });
    expect(session.requireAdmin).toHaveBeenCalledWith({ w: "riva", minRole: "ops" });
    expect(svc.createNotice).toHaveBeenCalledWith("DB", actor, { ...form, workspaceId: "ws1" });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/notices");
  });

  it("end and pin call their services", async () => {
    await endNoticeAction(null, "n1");
    expect(svc.endNotice).toHaveBeenCalledWith("DB", actor, { workspaceId: "ws1", noticeId: "n1" });
    await pinNoticeAction(null, "n1", true, 3);
    expect(svc.updateNotice).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      noticeId: "n1",
      pinned: true,
      version: 3,
    });
  });

  it("the info board saves through setWorkspaceInfo (ops)", async () => {
    expect(await setInfoAction("riva", "**Nanu** 08:00", 4)).toEqual({ ok: true });
    expect(session.requireAdmin).toHaveBeenCalledWith({ w: "riva", minRole: "ops" });
    expect(ws.setWorkspaceInfo).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      infoMd: "**Nanu** 08:00",
      version: 4,
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/notices");
  });

  it("a service error comes back as plain text, nothing revalidated", async () => {
    svc.endNotice.mockRejectedValue(new ServiceError("CONFLICT", "This notice has ended."));
    expect(await endNoticeAction(null, "n1")).toEqual({ ok: false, error: "This notice has ended." });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("anything else (a login redirect) is rethrown", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    session.requireAdmin.mockRejectedValue(redirect);
    await expect(endNoticeAction(null, "n1")).rejects.toBe(redirect);
  });
});
