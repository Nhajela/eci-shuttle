import { describe, expect, it } from "vitest";
import type { Device, Directive } from "@/db/types";
import type { PhoneHealth } from "@/services/devices/phones";
import {
  agoText,
  directiveText,
  istInputToIso,
  istInputValue,
  phoneProblems,
  phoneStatus,
  untilFromHours,
} from "./view";

// 2026-10-12 10:00 IST
const NOW = Date.parse("2026-10-12T04:30:00Z");

function health(over: Partial<PhoneHealth> = {}, dev: Partial<Device> = {}): PhoneHealth {
  return {
    device: {
      id: "d1",
      workspaceId: "w1",
      label: "Raju's phone",
      reportedMode: "active",
      battery: 80,
      charging: false,
      killedAt: null,
      revokedAt: null,
      ...dev,
    } as Device,
    vehicle: null,
    desiredMode: "active",
    modeMismatch: false,
    configBehind: false,
    lastSyncAgoS: 20,
    needsNewApk: false,
    updateFailed: false,
    permissionsOk: true,
    permissions: null,
    activeDirectives: [],
    ...over,
  };
}

describe("phoneStatus", () => {
  it("revoked wins over everything", () => {
    expect(phoneStatus(health({}, { revokedAt: new Date(NOW), killedAt: new Date(NOW) }))).toEqual({
      label: "Revoked",
      tone: "muted",
    });
  });
  it("killed", () => {
    expect(phoneStatus(health({}, { killedAt: new Date(NOW) }))).toEqual({ label: "Killed", tone: "bad" });
  });
  it("tracking when reported active", () => {
    expect(phoneStatus(health())).toEqual({ label: "Tracking", tone: "ok" });
  });
  it("idle", () => {
    expect(phoneStatus(health({ desiredMode: "idle" }, { reportedMode: "idle" }))).toEqual({
      label: "Idle",
      tone: "ok",
    });
  });
  it("never synced", () => {
    expect(phoneStatus(health({ lastSyncAgoS: null }, { reportedMode: null }))).toEqual({
      label: "Never synced",
      tone: "warn",
    });
  });
  it("any problem turns an ok status into warn", () => {
    expect(phoneStatus(health({ updateFailed: true })).tone).toBe("warn");
  });
});

describe("phoneProblems", () => {
  it("none for a healthy phone", () => {
    expect(phoneProblems(health())).toEqual([]);
  });
  it("lists reported vs desired, config, OTA, battery and permissions", () => {
    const p = phoneProblems(
      health(
        {
          desiredMode: "active",
          modeMismatch: true,
          configBehind: true,
          needsNewApk: true,
          updateFailed: true,
          permissionsOk: false,
          permissions: {
            location: "foreground",
            preciseLocation: true,
            notifications: false,
            batteryOptimizationExempt: true,
          },
        },
        { reportedMode: "idle", battery: 9, charging: false },
      ),
    );
    expect(p).toEqual([
      "Told active, reports idle",
      "Hasn't picked up the latest config",
      "Needs new APK",
      "Update failed",
      "Battery 9%",
      "Missing: location all the time, notifications",
    ]);
  });
  it("low battery while charging is fine; silent tracker is flagged", () => {
    expect(phoneProblems(health({ lastSyncAgoS: 600 }, { battery: 9, charging: true }))).toEqual(["Silent for 10 min"]);
  });
  it("killed or revoked phones report no problems", () => {
    expect(phoneProblems(health({ modeMismatch: true }, { revokedAt: new Date(NOW) }))).toEqual([]);
  });
});

describe("agoText", () => {
  it.each([
    [null, "never"],
    [5, "just now"],
    [125, "2 min ago"],
    [7300, "2 h ago"],
    [200_000, "2 d ago"],
  ])("%s → %s", (s, out) => {
    expect(agoText(s)).toBe(out);
  });
});

describe("directiveText (IST)", () => {
  const d = (kind: Directive["kind"], endsAt: string) => ({ kind, endsAt: new Date(endsAt) }) as Directive;
  it("same IST day shows HH:MM", () => {
    expect(directiveText(d("silence_until", "2026-10-12T10:30:00Z"), NOW)).toBe("Silenced until 16:00");
    expect(directiveText(d("force_active", "2026-10-12T13:00:00Z"), NOW)).toBe("Forced active until 18:30");
  });
  it("another day shows the date", () => {
    expect(directiveText(d("silence_until", "2026-10-13T03:30:00Z"), NOW)).toBe("Silenced until Tue 13 Oct, 09:00");
  });
});

describe("time inputs", () => {
  it("untilFromHours adds hours to now", () => {
    expect(untilFromHours(NOW, 2)).toBe("2026-10-12T06:30:00.000Z");
  });
  it("rejects non-positive or silly hours", () => {
    expect(() => untilFromHours(NOW, 0)).toThrow();
    expect(() => untilFromHours(NOW, Number.NaN)).toThrow();
    expect(() => untilFromHours(NOW, 49)).toThrow();
  });
  it("datetime-local values are IST, whatever the browser zone", () => {
    expect(istInputToIso("2026-10-12T16:00")).toBe("2026-10-12T10:30:00.000Z");
    expect(() => istInputToIso("nope")).toThrow();
  });
  it("istInputValue renders now in IST for the picker", () => {
    expect(istInputValue(NOW)).toBe("2026-10-12T10:00");
  });
});
