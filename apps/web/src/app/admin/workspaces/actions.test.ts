import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel";

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  createPairingCode: vi.fn(),
  revokePhone: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("@/lib/session", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/services/catalog/workspaces", () => ({
  createWorkspace: m.createWorkspace,
  updateWorkspace: m.updateWorkspace,
}));
vi.mock("@/services/devices/pairing", () => ({ createPairingCode: m.createPairingCode }));
vi.mock("@/services/devices/phones", () => ({ revokePhone: m.revokePhone }));

const { createWorkspaceAction, opsHoursAction, startSimAction, stopSimAction } = await import("./actions");

const actor = { kind: "admin", id: "p1" };
const ws = (isLive: boolean) => ({ id: "ws1", slug: isLive ? "live" : "test", name: "Test", isLive });
const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAdmin.mockResolvedValue({ actor, workspace: ws(false), role: "admin" });
});

describe("createWorkspaceAction", () => {
  it("creates the workspace with the actor and links to it", async () => {
    m.createWorkspace.mockResolvedValue({ id: "ws2", slug: "test-2", name: "Test 2" });
    const r = await createWorkspaceAction(null, form({ w: "test", slug: "test-2", name: "Test 2" }));
    expect(m.requireAdmin).toHaveBeenCalledWith({ w: "test" });
    expect(m.createWorkspace).toHaveBeenCalledWith("DB", actor, { slug: "test-2", name: "Test 2" });
    expect(r).toEqual({ ok: true, message: "Created Test 2.", slug: "test-2" });
    expect(m.revalidatePath).toHaveBeenCalledWith("/admin/workspaces");
  });

  it("shows the service error in plain words", async () => {
    m.createWorkspace.mockRejectedValue(new ServiceError("CONFLICT", "That slug is taken."));
    const r = await createWorkspaceAction(null, form({ slug: "test", name: "T" }));
    expect(r).toEqual({ ok: false, message: "That slug is taken." });
  });
});

describe("startSimAction", () => {
  it("makes a sim pairing code and the command to run", async () => {
    m.createPairingCode.mockResolvedValue({
      code: "123456",
      qrUrl: "x",
      expiresAt: new Date("2026-10-12T10:00:00Z"),
    });
    const r = await startSimAction(null, form({ w: "test", vehicle: "Bus 1" }));
    expect(m.requireAdmin).toHaveBeenCalledWith({ w: "test", minRole: "admin" });
    expect(m.createPairingCode).toHaveBeenCalledWith("DB", actor, { workspaceId: "ws1", label: "Sim: Bus 1" });
    expect(r).toEqual({
      ok: true,
      message: "Code 123456 works until 15:30.",
      command: 'pnpm sim test "Bus 1" 123456',
    });
  });

  it("refuses the live workspace", async () => {
    m.requireAdmin.mockResolvedValue({ actor, workspace: ws(true), role: "admin" });
    const r = await startSimAction(null, form({ vehicle: "Bus 1" }));
    expect(r.ok).toBe(false);
    expect(m.createPairingCode).not.toHaveBeenCalled();
  });

  it("needs a vehicle", async () => {
    const r = await startSimAction(null, form({ vehicle: " " }));
    expect(r).toEqual({ ok: false, message: "Pick a vehicle." });
  });
});

describe("stopSimAction", () => {
  it("revokes the sim phone in the current workspace", async () => {
    m.revokePhone.mockResolvedValue({});
    const r = await stopSimAction(null, form({ w: "test", deviceId: "d1" }));
    expect(m.revokePhone).toHaveBeenCalledWith("DB", actor, { workspaceId: "ws1", deviceId: "d1" });
    expect(r).toEqual({ ok: true, message: "Stopped. The sim stops on its next sync." });
    expect(m.revalidatePath).toHaveBeenCalledWith("/admin/workspaces");
  });

  it("maps unexpected errors to a generic message", async () => {
    m.revokePhone.mockRejectedValue(new Error("boom"));
    const r = await stopSimAction(null, form({ deviceId: "d1" }));
    expect(r).toEqual({ ok: false, message: "Something went wrong. Try again." });
  });
});

describe("opsHoursAction", () => {
  it("sets the hours (admin), or turns them off when both are empty", async () => {
    m.updateWorkspace.mockResolvedValue({});
    const r = await opsHoursAction(null, form({ w: "test", start: "09:00", end: "21:00" }));
    expect(m.requireAdmin).toHaveBeenCalledWith({ w: "test", minRole: "admin" });
    expect(m.updateWorkspace).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      opsHoursStart: "09:00",
      opsHoursEnd: "21:00",
    });
    expect(r).toEqual({ ok: true, message: "Phones in vehicles track 09:00–21:00 every day." });
    expect(m.revalidatePath).toHaveBeenCalledWith("/admin/workspaces");

    const off = await opsHoursAction(null, form({ start: "", end: "" }));
    expect(m.updateWorkspace).toHaveBeenLastCalledWith("DB", actor, {
      workspaceId: "ws1",
      opsHoursStart: null,
      opsHoursEnd: null,
    });
    expect(off).toEqual({ ok: true, message: "Ops hours off: phones track only during services." });
    // the "Turn off" button wins over the times still in the inputs
    await opsHoursAction(null, form({ start: "09:00", end: "21:00", off: "1" }));
    expect(m.updateWorkspace).toHaveBeenLastCalledWith("DB", actor, {
      workspaceId: "ws1",
      opsHoursStart: null,
      opsHoursEnd: null,
    });
  });

  it("shows the service error in plain words", async () => {
    m.updateWorkspace.mockRejectedValue(new ServiceError("INVALID", "Set both times, or neither."));
    expect(await opsHoursAction(null, form({ start: "09:00", end: "" }))).toEqual({
      ok: false,
      message: "Set both times, or neither.",
    });
  });
});
