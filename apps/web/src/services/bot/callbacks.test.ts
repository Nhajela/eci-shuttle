import { describe, expect, it } from "vitest";
import { decodeCallback, encodeCallback } from "./callbacks";

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
