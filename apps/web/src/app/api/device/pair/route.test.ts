import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel";

vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("@/services/devices/pairing", () => ({ pairDevice: vi.fn() }));

const { pairDevice } = await import("@/services/devices/pairing");
const { POST } = await import("./route");

const body = { code: "123456", model: "Pixel 7", appVersion: "1.0.0", updateId: null, pushToken: null };

const req = (ip: string, json: unknown = body, xff = "6.6.6.6") =>
  new Request("http://x/api/device/pair", {
    method: "POST",
    headers: { "cf-connecting-ip": ip, "x-forwarded-for": `${xff}, ${ip}` },
    body: typeof json === "string" ? json : JSON.stringify(json),
  });

beforeEach(() => {
  vi.mocked(pairDevice).mockReset();
});

describe("POST /api/device/pair", () => {
  it("swaps the code for a device token", async () => {
    vi.mocked(pairDevice).mockResolvedValue({ deviceId: "d1", token: "t" } as never);

    const res = await POST(req("1.1.1.1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: "d1", token: "t" });
    const [db, input, now] = vi.mocked(pairDevice).mock.calls[0] ?? [];
    expect(db).toBe("DB");
    expect(input).toEqual(body);
    expect(now).toBeInstanceOf(Date);
  });

  it("maps used/expired codes to 410 and unknown codes to 404", async () => {
    vi.mocked(pairDevice).mockRejectedValueOnce(new ServiceError("GONE", "That code has expired."));
    vi.mocked(pairDevice).mockRejectedValueOnce(new ServiceError("NOT_FOUND", "Unknown code."));

    const gone = await POST(req("2.2.2.2"));
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ error: "That code has expired." });
    expect((await POST(req("2.2.2.2"))).status).toBe(404);
  });

  it("rejects malformed JSON and invalid bodies with 400", async () => {
    expect((await POST(req("3.3.3.3", "nope"))).status).toBe(400);
    expect((await POST(req("3.3.3.3", { code: "1" }))).status).toBe(400);
    expect(pairDevice).not.toHaveBeenCalled();
  });

  it("rate limits pairing attempts per client address so codes can't be brute-forced", async () => {
    vi.mocked(pairDevice).mockImplementation(async () => {
      throw new ServiceError("NOT_FOUND", "Unknown code.");
    });

    for (let i = 0; i < 10; i++) expect((await POST(req("4.4.4.4"))).status).toBe(404);
    const limited = await POST(req("4.4.4.4"));

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await POST(req("5.5.5.5"))).status).toBe(404);
  });

  it("ignores a spoofed X-Forwarded-For: same cf-connecting-ip with fresh XFF values still gets 429", async () => {
    vi.mocked(pairDevice).mockImplementation(async () => {
      throw new ServiceError("NOT_FOUND", "Unknown code.");
    });

    for (let i = 0; i < 10; i++) expect((await POST(req("7.7.7.7", body, `9.9.9.${i}`))).status).toBe(404);

    expect((await POST(req("7.7.7.7", body, "9.9.9.99"))).status).toBe(429);
  });

  it("falls back to the last X-Forwarded-For hop, not the client-controlled first one", async () => {
    vi.mocked(pairDevice).mockRejectedValue(new ServiceError("NOT_FOUND", "Unknown code."));
    const viaProxy = (fake: string) =>
      new Request("http://x/api/device/pair", {
        method: "POST",
        headers: { "x-forwarded-for": `${fake}, 8.8.8.8` },
        body: JSON.stringify(body),
      });

    for (let i = 0; i < 10; i++) expect((await POST(viaProxy(`1.0.0.${i}`))).status).toBe(404);

    expect((await POST(viaProxy("1.0.0.99"))).status).toBe(429);
  });

  it("caps all pairing attempts at 60 a minute, so a distributed guesser is slowed too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 120_000); // a fresh window, clear of the attempts made by the tests above
    vi.mocked(pairDevice).mockRejectedValue(new ServiceError("NOT_FOUND", "Unknown code."));

    for (let i = 0; i < 60; i++) expect((await POST(req(`20.0.0.${i}`))).status).toBe(404);

    expect((await POST(req("30.0.0.1"))).status).toBe(429);
    vi.useRealTimers();
  });
});
