import { describe, expect, it } from "vitest";
import { McpChange, NoticeCreateFields, NoticePlacement, SyncRequest, SyncResponse } from ".";

const uuid = "0b9f1c2e-6a57-4f43-9a51-2a3c0d4e5f60";

describe("contracts", () => {
  it("notice placements accept the five forms and reject others", () => {
    for (const p of ["everywhere", "schedule", "admin", `spot:${uuid}`, `service:${uuid}`])
      expect(NoticePlacement.safeParse(p).success).toBe(true);
    for (const p of ["spot:", "spot:abc", "route:x", "Everywhere"])
      expect(NoticePlacement.safeParse(p).success).toBe(false);
  });

  it("notice create fills defaults", () => {
    const n = NoticeCreateFields.parse({ text: "Pickup at the side gate", placements: [`spot:${uuid}`] });
    expect(n).toMatchObject({ severity: "info", pinned: false, channels: [], startsAt: null, endsAt: null });
  });

  it("MCP change kinds discriminate, and exceptions are refined", () => {
    expect(McpChange.parse({ kind: "phone.nudge", deviceId: uuid })).toEqual({ kind: "phone.nudge", deviceId: uuid });
    const cancel = { kind: "service.exception", serviceId: uuid, date: "2026-10-14", type: "cancel_departure" };
    expect(McpChange.safeParse(cancel).success).toBe(false);
    expect(McpChange.safeParse({ ...cancel, departure: "10:20" }).success).toBe(true);
    expect(McpChange.safeParse({ ...cancel, type: "cancel_day" }).success).toBe(true);
    expect(McpChange.safeParse({ kind: "nope" }).success).toBe(false);
  });

  it("sync request/response round-trip", () => {
    const req = {
      pings: [
        { recordedAt: 1_760_000_000_000, lat: 15.66, lng: 73.71, accuracy: 8, speed: null, heading: null, battery: 80 },
      ],
      battery: 80,
      charging: false,
      permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
      reportedMode: "active",
      appliedConfigVersion: 3,
      appVersion: "1.0.0",
      updateId: null,
      clock: 1_760_000_000_500,
    };
    expect(SyncRequest.parse(req)).toEqual(req);
    const res = {
      configVersion: 4,
      killed: false,
      revoked: false,
      schedule: [],
      activeIntervalS: 10,
      idleHeartbeatS: 900,
      minAppVersion: null,
      apkUrl: null,
      targetUpdateId: null,
      apiOrigin: "https://eci-shuttle.positivesumcompany.com",
      serverTime: 1_760_000_001_000,
      vehicleName: null,
      workspace: { slug: "live", isLive: true },
    };
    expect(SyncResponse.parse(res)).toEqual(res);
  });
});
