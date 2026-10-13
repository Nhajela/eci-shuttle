import { describe, expect, it } from "vitest";
import type { McpContext } from "./context";
import { buildInitialize } from "./initialize";

const ctx = (targetUpdateId: string | null) =>
  ({
    db: {},
    now: new Date("2026-10-12T04:50:00Z"),
    person: { firstName: "Asha", lastName: null, username: null },
    client: "claude.ai",
    workspaces: [{ id: "w1", slug: "test", name: "Test", isLive: false, role: "admin", targetUpdateId }],
    inWorkspace: () => Promise.reject(new Error("offline")),
  }) as unknown as McpContext;

describe("shuttle_initialize", () => {
  it("shows the workspace's app update target", async () => {
    expect(await buildInitialize(ctx("01a13327-aaaa"), [])).toContain(
      "App update for every phone: 01a13327-aaaa (phones may override it; see shuttle_phones)",
    );
    expect(await buildInitialize(ctx(null), [])).toContain("App update for every phone: none set");
  });
});
