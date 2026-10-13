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
});
