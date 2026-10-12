import { describe, expect, it } from "vitest";
import { isSyncPush } from "./payload";

// What svc-push sends: { to, data: { type: "sync", deviceId, reason }, priority: "high" } (data-only)
const sent = { type: "sync", deviceId: "d1", reason: "config" };

describe("isSyncPush (SPEC §4: a push means only 'sync now')", () => {
  it("accepts the data object directly on the task payload", () => {
    expect(isSyncPush({ notification: null, data: sent })).toBe(true);
  });

  it("accepts data that Android hands over as a JSON string (dataString or Expo's body)", () => {
    expect(isSyncPush({ notification: null, data: { dataString: JSON.stringify(sent) } })).toBe(true);
    expect(isSyncPush({ notification: null, data: { body: JSON.stringify(sent), experienceId: "@x/y" } })).toBe(true);
  });

  it("accepts a tapped notification response carrying the sync data", () => {
    expect(isSyncPush({ notification: { request: { content: { data: sent } } }, actionIdentifier: "x" })).toBe(true);
  });

  it("ignores pushes of another type", () => {
    expect(isSyncPush({ notification: null, data: { type: "other" } })).toBe(false);
  });

  it("never throws on junk", () => {
    for (const junk of [undefined, null, 1, "sync", {}, { data: null }, { data: { body: "{not json" } }]) {
      expect(isSyncPush(junk)).toBe(false);
    }
  });
});
