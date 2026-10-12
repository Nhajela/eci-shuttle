import { describe, expect, it } from "vitest";
import { autostartIntents, checklist, nextRoute } from "./setup";

describe("nextRoute", () => {
  const s = { consentAt: 1, paired: true, setupDoneAt: 2 };
  it("walks consent → pair → permissions → status", () => {
    expect(nextRoute({ consentAt: null, paired: false, setupDoneAt: null })).toBe("/consent");
    expect(nextRoute({ ...s, paired: false, setupDoneAt: null })).toBe("/pair");
    expect(nextRoute({ ...s, setupDoneAt: null })).toBe("/permissions");
    expect(nextRoute(s)).toBe("/status");
  });
  it("a phone that lost its token (revoked) pairs again but skips setup it already did", () => {
    expect(nextRoute({ ...s, paired: false })).toBe("/pair");
  });
});

describe("checklist", () => {
  const ok = { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true } as const;
  it("is all set when location is always + precise, notifications on and battery exempt", () => {
    const c = checklist(ok);
    expect(c.allSet).toBe(true);
    expect(c.items.map((i) => i.key)).toEqual(["location", "notifications", "battery", "autostart"]);
  });
  it("location 'while using' or imprecise is not enough", () => {
    expect(checklist({ ...ok, location: "foreground" }).allSet).toBe(false);
    expect(checklist({ ...ok, preciseLocation: false }).allSet).toBe(false);
    expect(checklist({ ...ok, batteryOptimizationExempt: false }).allSet).toBe(false);
    expect(checklist({ ...ok, notifications: false }).allSet).toBe(false);
  });
  it("autostart can't be detected, so it never blocks", () => {
    expect(checklist(ok).items.find((i) => i.key === "autostart")).toMatchObject({ done: null, required: false });
  });
});

describe("autostartIntents", () => {
  it("knows the common OEM autostart screens, case-insensitively", () => {
    expect(autostartIntents("Xiaomi")[0]).toEqual({
      packageName: "com.miui.securitycenter",
      className: "com.miui.permcenter.autostart.AutoStartManagementActivity",
    });
    for (const m of ["oppo", "vivo", "realme", "OnePlus", "HUAWEI", "honor", "Redmi", "POCO", "asus", "Letv"])
      expect(autostartIntents(m).length).toBeGreaterThan(0);
  });
  it("returns nothing for phones without one (stock Android, Samsung)", () => {
    expect(autostartIntents("Google")).toEqual([]);
    expect(autostartIntents(null)).toEqual([]);
  });
});
