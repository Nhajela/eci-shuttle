import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { ServiceError } from "@/services/kernel";

vi.mock("@/services/catalog/workspaces", () => ({ workspaceBySlug: vi.fn() }));
vi.mock("@/services/auth/actor", () => ({ adminActor: vi.fn(), resolveWorkspace: vi.fn() }));
vi.mock("@/services/catalog/spots", () => ({ listSpots: vi.fn() }));
vi.mock("@/services/catalog/routes", () => ({ listRoutes: vi.fn() }));
vi.mock("@/services/catalog/vehicles", () => ({ listVehicles: vi.fn() }));
vi.mock("@/services/catalog/schedule", () => ({ getSchedule: vi.fn() }));
vi.mock("@/services/devices/phones", () => ({ listPhones: vi.fn() }));
vi.mock("@/services/ingest/ingest", () => ({ vehicleStates: vi.fn() }));
vi.mock("@/services/public/status", () => ({ publicStatus: vi.fn() }));
vi.mock("@/services/learning/insights", () => ({ getInsights: vi.fn(), listSuggestions: vi.fn() }));
vi.mock("@/services/activity/activity", async (orig) => ({
  ...(await orig<typeof import("@/services/activity/activity")>()),
  listActivity: vi.fn(),
  describeAudit: vi.fn((r: { action: string }) => `Asha did ${r.action}`),
}));

const { adminActor, resolveWorkspace } = await import("@/services/auth/actor");
const { workspaceBySlug } = await import("@/services/catalog/workspaces");
const { listSpots } = await import("@/services/catalog/spots");
const { listRoutes } = await import("@/services/catalog/routes");
const { listVehicles } = await import("@/services/catalog/vehicles");
const { getSchedule } = await import("@/services/catalog/schedule");
const { listPhones } = await import("@/services/devices/phones");
const { vehicleStates } = await import("@/services/ingest/ingest");
const { publicStatus } = await import("@/services/public/status");
const { getInsights, listSuggestions } = await import("@/services/learning/insights");
const { listActivity } = await import("@/services/activity/activity");
const { READ_TOOLS, READ_TEXT, readTool, toModel } = await import("./read");

const db = {} as Db;
// 20:00 UTC on 12 Oct = 01:30 IST on 13 Oct
const now = new Date("2026-10-12T20:00:00Z");
const ctx = { db, personId: "p1", client: "claude.ai", now };
const ws = { id: "w1", slug: "eci", name: "ECI", isLive: true };
const actor = { kind: "admin", id: "p1", workspaceId: "w1", role: "viewer", channel: "mcp", client: "claude.ai" };

const run = (name: string, input: unknown = {}) => readTool(name).run(ctx, input);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workspaceBySlug).mockResolvedValue(ws as never);
  vi.mocked(resolveWorkspace).mockResolvedValue({ workspace: ws, role: "viewer" } as never);
  vi.mocked(adminActor).mockResolvedValue(actor as never);
});

describe("tool list", () => {
  it("has the ten read tools, each with a description constant and a zod input", () => {
    expect(READ_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "shuttle_activity",
        "shuttle_insights",
        "shuttle_phones",
        "shuttle_public_answer",
        "shuttle_routes",
        "shuttle_schedule",
        "shuttle_spots",
        "shuttle_status",
        "shuttle_suggestions",
        "shuttle_vehicles",
      ].sort(),
    );
    for (const t of READ_TOOLS) {
      expect(t.description).toBe(READ_TEXT[t.name as keyof typeof READ_TEXT]);
      expect(t.input.safeParse({}).success).toBe(true);
    }
  });
});

describe("workspace and actor", () => {
  it("builds an mcp admin actor for the named workspace", async () => {
    vi.mocked(listSpots).mockResolvedValue([]);
    await run("shuttle_spots", { workspace: "eci" });
    expect(workspaceBySlug).toHaveBeenCalledWith(db, "eci");
    expect(adminActor).toHaveBeenCalledWith(db, {
      personId: "p1",
      workspaceId: "w1",
      channel: "mcp",
      client: "claude.ai",
    });
    expect(listSpots).toHaveBeenCalledWith(db, actor, { workspaceId: "w1", includeArchived: undefined });
  });

  it("defaults to the person's own workspace (live first)", async () => {
    vi.mocked(listSpots).mockResolvedValue([]);
    await run("shuttle_spots");
    expect(resolveWorkspace).toHaveBeenCalledWith(db, "p1", null);
    expect(workspaceBySlug).not.toHaveBeenCalled();
  });

  it("unknown slug is NOT_FOUND, never another workspace", async () => {
    vi.mocked(workspaceBySlug).mockResolvedValue(null);
    await expect(run("shuttle_spots", { workspace: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(adminActor).not.toHaveBeenCalled();
  });

  it("no memberships at all is FORBIDDEN", async () => {
    vi.mocked(resolveWorkspace).mockResolvedValue(null);
    await expect(run("shuttle_spots")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a non-member is refused by adminActor before any read", async () => {
    vi.mocked(adminActor).mockRejectedValue(new ServiceError("FORBIDDEN", "no"));
    await expect(run("shuttle_spots", { workspace: "eci" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(listSpots).not.toHaveBeenCalled();
  });

  it("bad input is INVALID", async () => {
    await expect(run("shuttle_schedule", { date: "13/10" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(run("shuttle_activity", { limit: 1000 })).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("toModel", () => {
  it("shows Dates in IST and hides device secrets", () => {
    expect(
      toModel({ a: [new Date("2026-10-12T04:10:00Z")], device: { label: "Bus", tokenHash: "x", pushToken: "y" } }),
    ).toEqual({ a: ["Mon 12 Oct, 09:40 IST"], device: { label: "Bus" } });
  });
});

describe("tools", () => {
  it("shuttle_status: every vehicle with its live state, vehicles read first (role check)", async () => {
    const order: string[] = [];
    vi.mocked(listVehicles).mockImplementation(async () => {
      order.push("vehicles");
      return [
        { id: "v1", name: "Bus 1" },
        { id: "v2", name: "Bus 2" },
      ] as never;
    });
    vi.mocked(vehicleStates).mockImplementation(async () => {
      order.push("states");
      return [{ vehicleId: "v1", phase: "moving", lastPingAt: new Date("2026-10-12T19:59:00Z") }] as never;
    });
    const out = (await run("shuttle_status")) as Record<string, unknown>;
    expect(order).toEqual(["vehicles", "states"]);
    expect(vehicleStates).toHaveBeenCalledWith(db, "w1");
    expect(out).toEqual({
      workspace: { slug: "eci", name: "ECI", isLive: true },
      now: "Tue 13 Oct, 01:30 IST",
      vehicles: [
        {
          vehicle: { id: "v1", name: "Bus 1" },
          state: { vehicleId: "v1", phase: "moving", lastPingAt: "Tue 13 Oct, 01:29 IST" },
        },
        { vehicle: { id: "v2", name: "Bus 2" }, state: null },
      ],
    });
  });

  it("shuttle_schedule: defaults to today in IST, departures as IST HH:MM", async () => {
    vi.mocked(getSchedule).mockResolvedValue([
      {
        date: "2026-10-13",
        services: [
          {
            service: { id: "s1" },
            exceptions: [],
            vehicles: [],
            departures: [
              { serviceId: "s1", date: "2026-10-13", at: Date.parse("2026-10-13T04:10:00Z"), planned: "09:40" },
            ],
          },
        ],
      },
    ] as never);
    const out = (await run("shuttle_schedule")) as { services: { departures: { at: string }[] }[] }[];
    expect(getSchedule).toHaveBeenCalledWith(db, actor, { workspaceId: "w1", from: "2026-10-13", days: 1 });
    expect(out[0]?.services[0]?.departures[0]?.at).toBe("09:40");
    await run("shuttle_schedule", { date: "2026-10-14", days: 7 });
    expect(getSchedule).toHaveBeenLastCalledWith(db, actor, { workspaceId: "w1", from: "2026-10-14", days: 7 });
  });

  it("shuttle_spots passes includeArchived", async () => {
    vi.mocked(listSpots).mockResolvedValue([]);
    await run("shuttle_spots", { includeArchived: true });
    expect(listSpots).toHaveBeenCalledWith(db, actor, { workspaceId: "w1", includeArchived: true });
  });

  it("shuttle_routes drops the path polyline and says how long it is", async () => {
    vi.mocked(listRoutes).mockResolvedValue([
      {
        id: "r1",
        name: "Loop",
        path: [
          { lat: 1, lng: 2 },
          { lat: 1, lng: 3 },
        ],
      },
    ] as never);
    expect(await run("shuttle_routes")).toEqual([{ id: "r1", name: "Loop", pathPoints: 2 }]);
  });

  it("shuttle_vehicles", async () => {
    vi.mocked(listVehicles).mockResolvedValue([{ id: "v1", name: "Bus 1" }] as never);
    expect(await run("shuttle_vehicles")).toEqual([{ id: "v1", name: "Bus 1" }]);
    expect(listVehicles).toHaveBeenCalledWith(db, actor, { workspaceId: "w1" });
  });

  it("shuttle_phones passes now and never shows the token hash", async () => {
    vi.mocked(listPhones).mockResolvedValue([
      { device: { id: "d1", label: "Bus", tokenHash: "h" }, lastSyncAgoS: 5 },
    ] as never);
    expect(await run("shuttle_phones")).toEqual([{ device: { id: "d1", label: "Bus" }, lastSyncAgoS: 5 }]);
    expect(listPhones).toHaveBeenCalledWith(db, actor, { workspaceId: "w1" }, now);
  });

  it("shuttle_activity: filters through, one plain line per row with the IST time", async () => {
    vi.mocked(listActivity).mockResolvedValue({
      rows: [{ id: 9, action: "spot.create", entity: "spot", at: new Date("2026-10-12T04:10:00Z") }],
      nextBefore: 9,
    } as never);
    const out = await run("shuttle_activity", { entity: "spot", proposalId: "pr1", before: 20, limit: 10 });
    expect(listActivity).toHaveBeenCalledWith(db, actor, {
      workspaceId: "w1",
      entity: "spot",
      proposalId: "pr1",
      before: 20,
      limit: 10,
    });
    expect(out).toEqual({
      rows: [
        {
          text: "Mon 12 Oct, 09:40 IST: Asha did spot.create",
          id: 9,
          action: "spot.create",
          entity: "spot",
          at: "Mon 12 Oct, 09:40 IST",
        },
      ],
      nextBefore: 9,
    });
  });

  it("shuttle_public_answer: whole status, or one spot by id, name or short name", async () => {
    const spots = [
      { spotId: "a", name: "Riva Beach", shortName: "Riva" },
      { spotId: "b", name: "Circle", shortName: "Circle" },
    ];
    vi.mocked(publicStatus).mockResolvedValue({ workspace: {}, notices: [], spots } as never);
    expect(await run("shuttle_public_answer")).toMatchObject({ spots });
    expect(publicStatus).toHaveBeenCalledWith(db, "w1", now);
    expect(await run("shuttle_public_answer", { spot: "riva" })).toMatchObject({ spots: [spots[0]] });
    expect(await run("shuttle_public_answer", { spot: "b" })).toMatchObject({ spots: [spots[1]] });
    await expect(run("shuttle_public_answer", { spot: "Nowhere" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("shuttle_insights: defaults to the last 7 IST days", async () => {
    vi.mocked(getInsights).mockResolvedValue({ trackedPct: 90 } as never);
    expect(await run("shuttle_insights")).toEqual({ trackedPct: 90 });
    expect(getInsights).toHaveBeenCalledWith(db, actor, { workspaceId: "w1", from: "2026-10-07", to: "2026-10-13" });
    await run("shuttle_insights", { from: "2026-10-01", to: "2026-10-02" });
    expect(getInsights).toHaveBeenLastCalledWith(db, actor, {
      workspaceId: "w1",
      from: "2026-10-01",
      to: "2026-10-02",
    });
  });

  it("shuttle_suggestions passes the status filter", async () => {
    vi.mocked(listSuggestions).mockResolvedValue([]);
    await run("shuttle_suggestions", { status: "open" });
    expect(listSuggestions).toHaveBeenCalledWith(db, actor, { workspaceId: "w1", status: "open" });
    await expect(run("shuttle_suggestions", { status: "bogus" })).rejects.toMatchObject({ code: "INVALID" });
  });
});
