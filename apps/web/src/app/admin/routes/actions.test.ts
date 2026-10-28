import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel/errors";

const actor = { kind: "admin" } as never;
vi.mock("@/lib/session", () => ({
  requireAdmin: vi.fn(async () => ({ actor, workspace: { id: "ws1", slug: "live" }, role: "ops" })),
}));
vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/services/catalog/routes", () => ({ createRoute: vi.fn(), updateRoute: vi.fn() }));
vi.mock("@/services/signal/dead-zones", () => ({ setLegNoSignal: vi.fn() }));

const { requireAdmin } = await import("@/lib/session");
const { createRoute, updateRoute } = await import("@/services/catalog/routes");
const { setLegNoSignal } = await import("@/services/signal/dead-zones");
const { createRouteAction, regeneratePathAction, savePathAction, setLegNoSignalAction, updateRouteAction } =
  await import("./actions");

function form(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
  return fd;
}

beforeEach(() => vi.clearAllMocks());

describe("route actions", () => {
  it("creates a route with the spots in the order picked, as ops in the chosen workspace", async () => {
    const r = await createRouteAction(null, form({ w: "live", name: "Riva loop", spotId: ["a", "b", "a"] }));
    expect(requireAdmin).toHaveBeenCalledWith({ w: "live", minRole: "ops" });
    expect(createRoute).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      name: "Riva loop",
      spotIds: ["a", "b", "a"],
    });
    expect(r).toEqual({ ok: true, message: "Route created." });
  });

  it("updates name and spots with the version the page loaded", async () => {
    await updateRouteAction(null, form({ w: "live", routeId: "r1", version: "3", name: "Loop", spotId: ["a", "b"] }));
    expect(updateRoute).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      routeId: "r1",
      version: 3,
      name: "Loop",
      spotIds: ["a", "b"],
    });
  });

  it("leaves the spots (and so the path) alone on a rename-only save", async () => {
    await updateRouteAction(null, form({ w: "live", routeId: "r1", version: "3", name: "New name" }));
    expect(vi.mocked(updateRoute).mock.calls[0][2]).toStrictEqual({
      workspaceId: "ws1",
      routeId: "r1",
      version: 3,
      name: "New name",
    });
  });

  it("sends the planned wait at each stop and per-stop overrides, in seconds", async () => {
    await updateRouteAction(
      null,
      form({ w: "live", routeId: "r1", version: "3", name: "Loop", waitMin: "5", "waitMin:b": "2", "waitMin:a": "" }),
    );
    expect(vi.mocked(updateRoute).mock.calls[0][2]).toStrictEqual({
      workspaceId: "ws1",
      routeId: "r1",
      version: 3,
      name: "Loop",
      plannedDwellS: { "*": 300, b: 120 },
    });
  });

  it("saves a hand-edited path", async () => {
    const path = [
      { lat: 15.6, lng: 73.7 },
      { lat: 15.61, lng: 73.71 },
    ];
    await savePathAction(null, form({ w: "live", routeId: "r1", version: "2", path: JSON.stringify(path) }));
    expect(updateRoute).toHaveBeenCalledWith("DB", actor, { workspaceId: "ws1", routeId: "r1", version: 2, path });
  });

  it("refuses a path that isn't a list of points without calling the service", async () => {
    const r = await savePathAction(null, form({ w: "live", routeId: "r1", version: "2", path: "nope" }));
    expect(updateRoute).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: false, message: "The edited path couldn't be read. Reload and try again." });
  });

  it("asks the service to regenerate the path", async () => {
    await regeneratePathAction(null, form({ w: "live", routeId: "r1", version: "5" }));
    expect(updateRoute).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      routeId: "r1",
      version: 5,
      regeneratePath: true,
    });
  });

  it("shows the service's plain-English error", async () => {
    vi.mocked(updateRoute).mockRejectedValueOnce(new ServiceError("STALE_VERSION", "Someone else changed this route."));
    const r = await regeneratePathAction(null, form({ w: "live", routeId: "r1", version: "5" }));
    expect(r).toEqual({ ok: false, message: "Someone else changed this route." });
  });
});

describe("setLegNoSignalAction", () => {
  it("marks a leg as an admin in the chosen workspace, with the version the page loaded", async () => {
    const r = await setLegNoSignalAction(
      null,
      form({ w: "live", routeId: "r1", version: "4", legIndex: "2", noSignal: "1" }),
    );
    expect(requireAdmin).toHaveBeenCalledWith({ w: "live", minRole: "admin" });
    expect(setLegNoSignal).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      routeId: "r1",
      version: 4,
      legIndex: 2,
      noSignal: true,
    });
    expect(r).toEqual({ ok: true, message: "Marked as no signal." });
  });

  it("unmarks with noSignal 0", async () => {
    const r = await setLegNoSignalAction(null, form({ w: "live", routeId: "r1", legIndex: "2", noSignal: "0" }));
    expect(vi.mocked(setLegNoSignal).mock.calls[0]?.[2]).toMatchObject({ legIndex: 2, noSignal: false });
    expect(r).toEqual({ ok: true, message: "Signal restored." });
  });

  it("maps a service error to a message", async () => {
    vi.mocked(setLegNoSignal).mockRejectedValueOnce(new ServiceError("FORBIDDEN", "This needs the admin role."));
    const r = await setLegNoSignalAction(null, form({ w: "live", routeId: "r1", legIndex: "2", noSignal: "1" }));
    expect(r).toEqual({ ok: false, message: "This needs the admin role." });
  });
});

describe("updateRouteAction says when no-signal marks were lost with the old stops", () => {
  it("names how many; plain 'Route saved.' otherwise", async () => {
    vi.mocked(updateRoute).mockResolvedValueOnce({ droppedNoSignalLegs: 2 } as never);
    const r = await updateRouteAction(
      null,
      form({ w: "live", routeId: "r1", version: "3", name: "L", spotId: ["a", "b"] }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(r?.message).toMatch(/^Route saved\. 2 "no signal" marks were removed/);
    vi.mocked(updateRoute).mockResolvedValueOnce({} as never);
    expect(await updateRouteAction(null, form({ w: "live", routeId: "r1", version: "3", name: "L" }))).toEqual({
      ok: true,
      message: "Route saved.",
    });
  });
});
