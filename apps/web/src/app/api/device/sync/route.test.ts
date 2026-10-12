import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel";

vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("@/services/devices/sync", () => ({ authenticateDevice: vi.fn(), syncDevice: vi.fn() }));

const { authenticateDevice, syncDevice } = await import("@/services/devices/sync");
const { POST } = await import("./route");

const body = {
  pings: [],
  battery: 80,
  charging: false,
  permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
  reportedMode: "idle",
  appliedConfigVersion: 3,
  appVersion: "1.0.0",
  updateId: null,
  clock: 1_760_000_000_000,
};

const req = (token: string | null, json: unknown = body) =>
  new Request("http://x/api/device/sync", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof json === "string" ? json : JSON.stringify(json),
  });

const device = (id: string) => ({ kind: "device" as const, id, workspaceId: "w1", channel: "device" as const });

beforeEach(() => {
  vi.mocked(authenticateDevice).mockReset();
  vi.mocked(syncDevice).mockReset();
});

describe("POST /api/device/sync", () => {
  it("authenticates the bearer token, syncs with the parsed body and returns the config", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue(device("d-ok"));
    vi.mocked(syncDevice).mockResolvedValue({ configVersion: 4 } as never);

    const res = await POST(req("tok"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configVersion: 4 });
    expect(authenticateDevice).toHaveBeenCalledWith("DB", "tok");
    const [db, actor, input, now] = vi.mocked(syncDevice).mock.calls[0] ?? [];
    expect([db, actor]).toEqual(["DB", device("d-ok")]);
    expect(input).toMatchObject({ appliedConfigVersion: 3, reportedMode: "idle" });
    expect(now).toBeInstanceOf(Date);
  });

  it("passes null when there is no bearer token and maps UNAUTHENTICATED to 401", async () => {
    vi.mocked(authenticateDevice).mockRejectedValue(new ServiceError("UNAUTHENTICATED", "Unknown device."));

    const res = await POST(req(null));

    expect(authenticateDevice).toHaveBeenCalledWith("DB", null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unknown device." });
    expect(syncDevice).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid bodies with 400 without syncing", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue(device("d-bad"));

    expect((await POST(req("tok", "{not json"))).status).toBe(400);
    expect((await POST(req("tok", { ...body, reportedMode: "flying" }))).status).toBe(400);
    expect(syncDevice).not.toHaveBeenCalled();
  });

  it("hides unexpected errors behind a 500 with a generic message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authenticateDevice).mockResolvedValue(device("d-500"));
    vi.mocked(syncDevice).mockRejectedValue(new Error("db exploded"));

    const res = await POST(req("tok"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong. Try again." });
  });

  it("rate limits per device with 429 and Retry-After, without touching other devices", async () => {
    vi.mocked(authenticateDevice).mockImplementation(async (_db, t) => device(t === "a" ? "d-rl-a" : "d-rl-b"));
    vi.mocked(syncDevice).mockResolvedValue({ configVersion: 1 } as never);

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await POST(req("a"))).status);
    const limited = await POST(req("a"));

    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await POST(req("b"))).status).toBe(200);
  });
});
