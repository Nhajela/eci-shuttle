import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = { kind: "person" };
const requireAdmin = vi.fn();
const silencePhone = vi.fn();
const nudgePhone = vi.fn();
const createNotice = vi.fn();
const addException = vi.fn();

vi.mock("@/lib/session", () => ({ requireAdmin }));
vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/services/devices/phones", () => ({ silencePhone, nudgePhone }));
vi.mock("@/services/notices/notices", () => ({ createNotice }));
vi.mock("@/services/catalog/schedule", () => ({ addException }));

const { cancelDepartureAction, nudgeAction, postNoticeAction, silenceAction } = await import("./actions");
const { ServiceError } = await import("@/services/kernel");

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ actor, workspace: { id: "ws1" }, role: "ops" });
});

describe("live board actions", () => {
  it("need ops and the workspace from ?w", async () => {
    await nudgeAction("riva", "d1");
    expect(requireAdmin).toHaveBeenCalledWith({ w: "riva", minRole: "ops" });
    expect(nudgePhone).toHaveBeenCalledWith("DB", actor, { workspaceId: "ws1", deviceId: "d1" });
  });

  it("silence a phone for N hours from now", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-12T04:00:00Z") });
    try {
      expect(await silenceAction(null, "d1", 1)).toEqual({ ok: true });
      expect(await silenceAction(null, ["d2", "d3"], 1)).toEqual({ ok: true });
      expect(vi.mocked(silencePhone).mock.calls.map((c) => (c[2] as { deviceId: string }).deviceId)).toEqual([
        "d1",
        "d2",
        "d3",
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(silencePhone).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      deviceId: "d1",
      until: "2026-10-12T05:00:00.000Z",
    });
  });

  it("post a notice everywhere, urgent when asked", async () => {
    await postNoticeAction(null, "Bus 2 is out today", true);
    expect(createNotice).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      text: "Bus 2 is out today",
      severity: "urgent",
      placements: ["everywhere"],
    });
  });

  it("cancel a departure by its service day and planned time", async () => {
    await cancelDepartureAction(null, "s1", "2026-10-12", "09:40");
    expect(addException).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      serviceId: "s1",
      date: "2026-10-12",
      type: "cancel_departure",
      departure: "09:40",
    });
  });

  it("turn service errors into a plain message", async () => {
    nudgePhone.mockRejectedValue(new ServiceError("FORBIDDEN", "You need ops to do that."));
    expect(await nudgeAction(null, "d1")).toEqual({ ok: false, error: "You need ops to do that." });
  });
});
