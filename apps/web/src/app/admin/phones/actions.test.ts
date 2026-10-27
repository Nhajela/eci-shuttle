import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel";

const actor = { kind: "admin", id: "p1" };
vi.mock("@/lib/session", () => ({
  requireAdmin: vi.fn(async () => ({ actor, workspace: { id: "w1", slug: "test" }, role: "admin" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("@/services/devices/phones", () => ({
  labelPhone: vi.fn(),
  assignPhone: vi.fn(),
  silencePhone: vi.fn(),
  forceActive: vi.fn(),
  cancelDirective: vi.fn(),
  nudgePhone: vi.fn(),
  killPhone: vi.fn(),
  resumePhone: vi.fn(),
  revokePhone: vi.fn(),
  movePhoneToWorkspace: vi.fn(),
}));
vi.mock("@/services/devices/pairing", () => ({
  createPairingCode: vi.fn(async () => ({
    code: "123456",
    qrUrl: "https://x.test/pair/123456",
    expiresAt: new Date("2026-10-12T05:00:00Z"),
  })),
}));
vi.mock("@/services/devices/ota", () => ({ rolloutUpdate: vi.fn(), setPhoneUpdate: vi.fn() }));

const { revalidatePath } = await import("next/cache");
const { requireAdmin } = await import("@/lib/session");
const phones = await import("@/services/devices/phones");
const ota = await import("@/services/devices/ota");
const a = await import("./actions");

// 2026-10-12 10:00 IST
const NOW = new Date("2026-10-12T04:30:00Z");
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("phone actions", () => {
  it("resolve the workspace from ?w and call the service with its id", async () => {
    expect(await a.nudgePhoneAction("test", "d1")).toEqual({ ok: true });
    expect(requireAdmin).toHaveBeenCalledWith({ w: "test" });
    expect(phones.nudgePhone).toHaveBeenCalledWith("DB", actor, { workspaceId: "w1", deviceId: "d1" });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/phones");
  });

  it("force active for N hours → until = now + N h", async () => {
    await a.forceActiveAction("test", "d1", 3);
    expect(phones.forceActive).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "w1",
      deviceId: "d1",
      until: "2026-10-12T07:30:00.000Z",
      intervalS: null,
    });
  });

  it("silence until reads the picker value as IST", async () => {
    await a.silencePhoneAction("test", "d1", "2026-10-12T16:00");
    expect(phones.silencePhone).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "w1",
      deviceId: "d1",
      until: "2026-10-12T10:30:00.000Z",
    });
  });

  it("bad input never reaches the service and comes back as a plain message", async () => {
    expect(await a.forceActiveAction("test", "d1", 0)).toEqual({ ok: false, error: "Pick between 0 and 48 hours." });
    expect(await a.silencePhoneAction("test", "d1", "")).toEqual({ ok: false, error: "Pick a date and time." });
    expect(phones.forceActive).not.toHaveBeenCalled();
    expect(phones.silencePhone).not.toHaveBeenCalled();
  });

  it("service errors map to their message; unexpected ones to a generic line", async () => {
    vi.mocked(phones.killPhone).mockRejectedValueOnce(new ServiceError("FORBIDDEN", "Only admins can kill a phone."));
    expect(await a.killPhoneAction("test", "d1")).toEqual({ ok: false, error: "Only admins can kill a phone." });
    vi.mocked(phones.revokePhone).mockRejectedValueOnce(new Error("db down"));
    expect(await a.revokePhoneAction("test", "d1")).toEqual({ ok: false, error: "Something went wrong. Try again." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("resume passes the phone through and revalidates", async () => {
    expect(await a.resumePhoneAction("test", "d1")).toEqual({ ok: true });
    expect(phones.resumePhone).toHaveBeenCalledWith("DB", actor, { workspaceId: "w1", deviceId: "d1" });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/phones");
  });

  it("assign, move, label, cancel pass their fields through", async () => {
    await a.assignPhoneAction("test", "d1", null);
    expect(phones.assignPhone).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "w1",
      deviceId: "d1",
      vehicleId: null,
    });
    await a.movePhoneAction("test", "d1", "w2");
    expect(phones.movePhoneToWorkspace).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "w1",
      deviceId: "d1",
      toWorkspaceId: "w2",
    });
    await a.labelPhoneAction("test", "d1", "Bus 1 phone");
    expect(phones.labelPhone).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "w1",
      deviceId: "d1",
      label: "Bus 1 phone",
    });
    await a.cancelDirectiveAction("test", "x1");
    expect(phones.cancelDirective).toHaveBeenCalledWith("DB", actor, { workspaceId: "w1", directiveId: "x1" });
  });

  it("OTA: blank update id means stop targeting / follow the workspace", async () => {
    await a.rolloutAction("test", "  ");
    expect(ota.rolloutUpdate).toHaveBeenCalledWith("DB", actor, { workspaceId: "w1", updateId: null });
    await a.phoneUpdateAction("test", "d1", "abc");
    expect(ota.setPhoneUpdate).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "w1",
      deviceId: "d1",
      updateId: "abc",
    });
  });

  it("pairing returns the code, an IST expiry and a QR image of the pairing URL", async () => {
    const r = await a.createPairingCodeAction("test", "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ code: "123456", qrUrl: "https://x.test/pair/123456", expiresIst: "10:30" });
    expect(r.data?.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
