import { describe, expect, it } from "vitest";
import type { Actor } from "./actor";
import { systemActor } from "./actor";
import type { ServiceError } from "./errors";
import { can, requireDevice, requireRole } from "./roles";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const admin = (role: Actor["role"], workspaceId = WS): Actor => ({
  kind: "admin",
  id: "p1",
  workspaceId,
  role,
  channel: "web",
});
const code = (f: () => void) => {
  try {
    f();
    return null;
  } catch (e) {
    return (e as ServiceError).code;
  }
};

describe("requireRole", () => {
  it("lets system actors through", () => {
    expect(code(() => requireRole(systemActor("watchdog"), WS, "admin"))).toBeNull();
  });

  it("orders roles viewer < ops < admin", () => {
    expect(code(() => requireRole(admin("admin"), WS, "ops"))).toBeNull();
    expect(code(() => requireRole(admin("ops"), WS, "ops"))).toBeNull();
    expect(code(() => requireRole(admin("viewer"), WS, "viewer"))).toBeNull();
    expect(code(() => requireRole(admin("viewer"), WS, "ops"))).toBe("FORBIDDEN");
    expect(code(() => requireRole(admin("ops"), WS, "admin"))).toBe("FORBIDDEN");
  });

  it("refuses another workspace", () => {
    expect(code(() => requireRole(admin("admin", OTHER), WS, "viewer"))).toBe("FORBIDDEN");
  });

  it("refuses an admin actor with no role", () => {
    expect(code(() => requireRole(admin(undefined), WS, "viewer"))).toBe("FORBIDDEN");
  });

  it("refuses devices: they act only on themselves via requireDevice", () => {
    const device: Actor = { kind: "device", id: "d1", workspaceId: WS, channel: "device" };
    expect(code(() => requireRole(device, WS, "viewer"))).toBe("FORBIDDEN");
    expect(code(() => requireDevice(device, "d1"))).toBeNull();
    expect(code(() => requireDevice(device, "d2"))).toBe("FORBIDDEN");
    expect(code(() => requireDevice(admin("admin"), "d1"))).toBe("FORBIDDEN");
  });

  it("can() answers without throwing", () => {
    expect(can(admin("ops"), WS, "ops")).toBe(true);
    expect(can(admin("ops"), WS, "admin")).toBe(false);
  });
});
