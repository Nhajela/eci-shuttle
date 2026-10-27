import { describe, expect, it } from "vitest";
import type { AuditRow } from "@/db/types";
import { describeAudit } from "./activity";

const row = (over: Partial<AuditRow>): AuditRow => ({
  id: 1,
  workspaceId: "ws",
  actorKind: "admin",
  actorId: "p1",
  actorLabel: "Asha",
  channel: "web",
  client: null,
  action: "spot.create",
  entity: "spot",
  entityId: "s1",
  before: null,
  after: null,
  reason: null,
  proposalId: null,
  at: new Date("2026-10-12T04:00:00Z"),
  ...over,
});

describe("describeAudit", () => {
  it("names the MCP client and the cancelled departure", () => {
    expect(
      describeAudit(
        row({
          channel: "mcp",
          client: "claude.ai",
          action: "service.exception",
          entity: "service",
          after: { kind: "cancel_departure", date: "2026-10-12", departure: "10:20" },
        }),
      ),
    ).toBe("Asha (MCP · claude.ai) cancelled the 10:20 departure on 2026-10-12");
  });

  it("describes the other one-day edits", () => {
    const ex = (after: Record<string, unknown>) =>
      describeAudit(row({ action: "service.exception", entity: "service", after }));
    expect(ex({ kind: "cancel_day", date: "2026-10-13" })).toBe("Asha cancelled every departure on 2026-10-13");
    expect(ex({ kind: "add_departure", date: "2026-10-13", departure: "18:00" })).toBe(
      "Asha added a 18:00 departure on 2026-10-13",
    );
    expect(ex({ kind: "shift_minutes", date: "2026-10-13", departure: "09:00", minutes: 10 })).toBe(
      "Asha moved the 09:00 departure by 10 min on 2026-10-13",
    );
    expect(
      describeAudit(
        row({
          action: "service.exception_remove",
          entity: "service",
          before: { kind: "cancel_departure", date: "2026-10-12", departure: "10:20" },
        }),
      ),
    ).toBe("Asha undid: cancelled the 10:20 departure on 2026-10-12");
  });

  it("speaks for a phone acting on itself", () => {
    expect(
      describeAudit(
        row({ actorKind: "device", actorLabel: "Bus 1", channel: "device", action: "device.resume", entity: "device" }),
      ),
    ).toBe("Phone 'Bus 1' resumed tracking");
  });

  it("tells a kill lifted by ops apart from a lifted pause, and a notice to the driver", () => {
    const r = (after: Record<string, unknown>, action = "phone.resume") =>
      describeAudit(row({ action, entity: "device", after }));
    expect(r({ killedAt: null, openSilences: [] })).toBe("Asha resumed a killed phone");
    expect(r({ openSilences: [] })).toBe("Asha lifted a phone's pause");
    expect(r({ key: "killed:1:2:3" }, "device.driver_notified")).toMatch(/told its driver why it isn't tracked$/);
  });

  it("names the object on create and lists changed fields on update", () => {
    expect(describeAudit(row({ after: { id: "s1", name: "Riva", radiusM: 75 } }))).toBe("Asha added spot 'Riva'");
    expect(
      describeAudit(
        row({
          channel: "telegram",
          action: "spot.update",
          before: { radiusM: 75, version: 1 },
          after: { radiusM: 120, version: 2 },
        }),
      ),
    ).toBe("Asha (Telegram) changed spot: radiusM 75 → 120");
    expect(
      describeAudit(row({ action: "spot.archive", before: { archivedAt: null }, after: { archivedAt: "x" } })),
    ).toBe("Asha archived spot");
  });

  it("covers phone actions and system actors", () => {
    expect(describeAudit(row({ action: "phone.kill", entity: "device" }))).toBe("Asha stopped a phone");
    expect(
      describeAudit(
        row({
          actorKind: "system",
          actorId: "watchdog",
          actorLabel: null,
          channel: "worker",
          action: "phone.nudge",
          entity: "device",
        }),
      ),
    ).toBe("watchdog nudged a phone");
  });

  it("shows timestamps in IST and null as none", () => {
    const upd = (before: Record<string, unknown>, after: Record<string, unknown>) =>
      describeAudit(row({ action: "notice.update", entity: "notice", before, after }));
    expect(upd({ endsAt: "2026-10-12T05:15:00.000Z" }, { endsAt: "2026-10-12T06:00:00.000Z" })).toBe(
      "Asha changed notice: endsAt Mon 12 Oct, 10:45 → Mon 12 Oct, 11:30",
    );
    expect(upd({ endsAt: null }, { endsAt: "2026-10-12T06:00:00.000Z" })).toBe(
      "Asha changed notice: endsAt none → Mon 12 Oct, 11:30",
    );
  });

  it("never prints secrets in the change list", () => {
    expect(
      describeAudit(
        row({
          action: "device.update",
          entity: "device",
          before: { pushToken: "ExpoA" },
          after: { pushToken: "ExpoB" },
        }),
      ),
    ).toBe("Asha changed device");
  });

  it("falls back to '<actor> <action> <entity>' for unknown actions", () => {
    expect(describeAudit(row({ action: "widget.frob", entity: "widget" }))).toBe("Asha widget.frob widget");
  });
});
