import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("@/services/catalog/workspaces", () => ({ workspaceBySlug: vi.fn() }));
vi.mock("@/services/public/status", () => ({ publicStatus: vi.fn() }));

import { workspaceBySlug } from "@/services/catalog/workspaces";
import { publicStatus } from "@/services/public/status";
import { GET } from "./route";

const ws = vi.mocked(workspaceBySlug);
const status = vi.mocked(publicStatus);
const body = { workspace: { slug: "live", name: "ECI", isLive: true }, generatedAt: "x", notices: [], spots: [] };

describe("GET /api/status", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    status.mockResolvedValue(body);
  });

  it("no ?w → the live workspace, cached at the edge for 5s", async () => {
    ws.mockResolvedValue({ id: "w1" } as never);
    const res = await GET(new Request("http://x/api/status"));
    expect(ws).toHaveBeenCalledWith("DB", null);
    expect(status).toHaveBeenCalledWith("DB", "w1", expect.any(Date));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=5");
    expect(await res.json()).toEqual(body);
  });

  it("?w=<slug> → that workspace", async () => {
    ws.mockResolvedValue({ id: "w2" } as never);
    await GET(new Request("http://x/api/status?w=test"));
    expect(ws).toHaveBeenCalledWith("DB", "test");
    expect(status).toHaveBeenCalledWith("DB", "w2", expect.any(Date));
  });

  it("unknown workspace → 404", async () => {
    ws.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/status?w=nope"));
    expect(res.status).toBe(404);
    expect(status).not.toHaveBeenCalled();
  });
});
