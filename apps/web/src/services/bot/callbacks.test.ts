import { describe, expect, it, vi } from "vitest";
import { onAdminCallback } from "./admin";
import { onAttendeeCallback } from "./attendee";
import { decodeCallback, encodeCallback, handleCallback } from "./callbacks";
import type { BotContext, BotReply } from "./types";

vi.mock("./admin", () => ({ onAdminCallback: vi.fn() }));
vi.mock("./attendee", () => ({ onAttendeeCallback: vi.fn() }));

const UUID = "0b9f6a52-7c1e-4f3a-9d2b-1e5c8a7f6d40";

describe("callback data", () => {
  it("round-trips an action with a uuid and a short arg", () => {
    const data = encodeCallback({ action: "arrive", args: [UUID, "10"] });
    expect(data).toBe(`arrive:${UUID}:10`);
    expect(decodeCallback(data)).toEqual({ action: "arrive", args: [UUID, "10"] });
    expect(decodeCallback("noop")).toEqual({ action: "noop", args: [] });
  });

  it("refuses data over 64 bytes and args containing ':'", () => {
    expect(() => encodeCallback({ action: "cdayok", args: [UUID, UUID] })).toThrow(/64 bytes/);
    expect(() => encodeCallback({ action: "nw", args: ["a:b"] })).toThrow(/":"/);
  });

  it("decodes unknown, empty or missing data as null", () => {
    expect(decodeCallback("bogus:1")).toBeNull();
    expect(decodeCallback("")).toBeNull();
    expect(decodeCallback(undefined)).toBeNull();
  });
});

describe("handleCallback", () => {
  const ctx = { chatId: 1 } as BotContext;
  const q = (data?: string) => ({ id: "q1", from: { id: 1 }, data });
  const A: BotReply = { send: [] };
  const B: BotReply = { send: [], answerCallback: { callbackQueryId: "q1" } };

  it("sends attendee buttons to the attendee side and the rest to admin", async () => {
    vi.mocked(onAttendeeCallback).mockResolvedValue(A);
    vi.mocked(onAdminCallback).mockResolvedValue(B);
    for (const a of ["spot", "arrive", "nsub", "nunsub", "every"]) {
      expect(await handleCallback(ctx, q(`${a}:x`))).toBe(A);
      expect(onAttendeeCallback).toHaveBeenLastCalledWith(ctx, { action: a, args: ["x"] }, q(`${a}:x`));
    }
    for (const a of ["nudge", "mute", "pause1h", "sil1h", "kill", "killok", "resume", "cday", "cdayok", "nw", "noop"])
      expect(await handleCallback(ctx, q(a))).toBe(B);
    expect(onAdminCallback).toHaveBeenCalledTimes(11);
  });

  it("answers an unknown or missing button as expired", async () => {
    vi.mocked(onAttendeeCallback).mockClear();
    vi.mocked(onAdminCallback).mockClear();
    for (const data of ["bogus:1", undefined])
      expect(await handleCallback(ctx, q(data))).toEqual({
        send: [],
        answerCallback: { callbackQueryId: "q1", text: "This button has expired" },
      });
    expect(onAttendeeCallback).not.toHaveBeenCalled();
    expect(onAdminCallback).not.toHaveBeenCalled();
  });
});
