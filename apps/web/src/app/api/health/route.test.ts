import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Health } from "@/services/health/health";

vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("@/services/health/health", () => ({ checkHealth: vi.fn() }));

const { checkHealth } = await import("@/services/health/health");
const { GET } = await import("./route");

const get = (q = "") => GET(new Request(`http://x/api/health${q}`));
const stale: Health = { ok: false, db: true, heartbeatAt: null, heartbeatAgeS: null };
const dbDown: Health = { ok: false, db: false, heartbeatAt: null, heartbeatAgeS: null };

beforeEach(() => {
  vi.mocked(checkHealth).mockReset();
});

describe("GET /api/health", () => {
  it("full check: 503 when the worker heartbeat is missing or stale", async () => {
    vi.mocked(checkHealth).mockResolvedValue(stale);
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(stale);
  });

  it("full check: 200 when ok", async () => {
    vi.mocked(checkHealth).mockResolvedValue({ ...stale, ok: true });
    expect((await get()).status).toBe(200);
  });

  it("?live=1: 200 while the db answers, even with no worker heartbeat", async () => {
    vi.mocked(checkHealth).mockResolvedValue(stale);
    const res = await get("?live=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: true });
  });

  it("?live=1: 503 when the db is down", async () => {
    vi.mocked(checkHealth).mockResolvedValue(dbDown);
    expect((await get("?live=1")).status).toBe(503);
  });

  it("503 when db() throws (no DATABASE_URL)", async () => {
    vi.mocked(checkHealth).mockRejectedValue(new Error("no url"));
    expect((await get("?live=1")).status).toBe(503);
    expect((await get()).status).toBe(503);
  });
});
