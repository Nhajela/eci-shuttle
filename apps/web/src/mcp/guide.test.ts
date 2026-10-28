import { describe, expect, it } from "vitest";
import { changeKindsReference, guideFor } from "./guide";

describe("shuttle_guide", () => {
  it("lists the OTA change kinds, admin only, with their fields", () => {
    const ref = changeKindsReference();
    expect(ref).toContain("- `ota.rollout` (admin): updateId*");
    expect(ref).toContain("- `ota.rollback` (admin): no fields");
    expect(ref).toContain("- `ota.phone` (admin): deviceId*, updateId*");
  });

  it("explains app updates in the changes and phones topics", () => {
    for (const topic of ["changes", "phones"] as const) {
      const text = guideFor(topic);
      expect(text).toContain("ota.rollout");
      expect(text).toContain("ota.phone");
    }
    expect(guideFor("phones")).toContain("only while idle");
  });

  it("kill: only an app phone waits for the driver's Resume; a Telegram or Traccar phone has no app, an admin resumes it", () => {
    const text = guideFor("phones");
    expect(text).toContain("has no app");
    expect(text).toMatch(/Telegram or Traccar phone[^.]*has no app[^.]*admin[^.]*resume/i);
  });

  it("explains ops tracking hours (workspace.update), admin only", () => {
    expect(changeKindsReference()).toContain("- `workspace.update` (admin): opsHoursStart*, opsHoursEnd*");
    for (const topic of ["changes", "phones", "roles"] as const)
      expect(guideFor(topic)).toContain("workspace.update { opsHoursStart");
  });

  it("explains the info board (workspace.info), ops", () => {
    expect(changeKindsReference()).toContain("- `workspace.info` (ops): infoMd*");
    expect(guideFor("notices")).toContain("workspace.info { infoMd");
  });
});
