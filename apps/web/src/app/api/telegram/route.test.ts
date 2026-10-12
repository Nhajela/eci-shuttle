import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeDb = { fake: true };
const handleUpdate = vi.fn();
const performReply = vi.fn();
vi.mock("@/db", () => ({ db: () => fakeDb }));
vi.mock("@/services/bot/handle", () => ({ handleUpdate: (...a: unknown[]) => handleUpdate(...a) }));
vi.mock("@/services/bot/deliver", () => ({ performReply: (...a: unknown[]) => performReply(...a) }));

const { POST } = await import("./route");

const SECRET = "s".repeat(32);
const post = (body: string, secret: string | null = SECRET) =>
  POST(
    new Request("https://x.test/api/telegram", {
      method: "POST",
      headers: secret === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret },
      body,
    }),
  );
let nextId = 7;
let update = { update_id: 7, message: { message_id: 1, date: 0, chat: { id: 5, type: "private" }, text: "/start" } };
const reply = { send: [{ chatId: 5, html: "hi", kind: "reply" }] };

const saved = process.env.TELEGRAM_WEBHOOK_SECRET;
beforeEach(() => {
  update = { ...update, update_id: nextId++ };
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  handleUpdate.mockReset().mockResolvedValue(reply);
  performReply.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = saved;
  vi.restoreAllMocks();
});

describe("POST /api/telegram", () => {
  it("401 without the secret header, and nothing is handled", async () => {
    expect((await post(JSON.stringify(update), null)).status).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it("401 with a wrong secret", async () => {
    expect((await post(JSON.stringify(update), "nope")).status).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it("routes the update to handleUpdate with a Date now, then performs the reply", async () => {
    const res = await post(JSON.stringify(update));
    expect(res.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledWith(fakeDb, update, expect.any(Date));
    expect(performReply).toHaveBeenCalledWith(fakeDb, reply);
  });

  it("handles a redelivered update_id only once (Telegram retries after a slow reply)", async () => {
    expect((await post(JSON.stringify(update))).status).toBe(200);
    expect((await post(JSON.stringify(update))).status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);
    expect(performReply).toHaveBeenCalledTimes(1);
  });

  it("drops a redelivery that arrives while the first is still being handled", async () => {
    let finish!: (v: unknown) => void;
    handleUpdate.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const first = post(JSON.stringify(update));
    expect((await post(JSON.stringify(update))).status).toBe(200);
    finish(reply);
    expect((await first).status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);
  });

  it("400 on a body that isn't a Telegram update", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ hello: 1 }))).status).toBe(400);
    expect((await post("null")).status).toBe(400);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it("answers 200 when handling fails, so Telegram doesn't redeliver the same update forever", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    handleUpdate.mockRejectedValueOnce(new Error("boom"));
    expect((await post(JSON.stringify(update))).status).toBe(200);
    expect(performReply).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("answers 200 when sending the reply fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    performReply.mockRejectedValueOnce(new Error("telegram down"));
    expect((await post(JSON.stringify(update))).status).toBe(200);
  });
});
