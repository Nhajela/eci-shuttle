import { describe, expect, it } from "vitest";
import { parseSimArgs } from "./args";

describe("parseSimArgs", () => {
  it("reads workspace, vehicle and code, defaulting to 1x", () => {
    expect(parseSimArgs(["test", "Bus 1", "123456"])).toEqual({
      slug: "test",
      vehicle: "Bus 1",
      code: "123456",
      speed: 1,
      origin: null,
      route: null,
    });
  });

  it("takes --speed, --origin and --route", () => {
    const a = parseSimArgs([
      "test",
      "Bus 1",
      "123456",
      "--speed",
      "10",
      "--origin",
      "http://localhost:3000/",
      "--route",
      "Loop",
    ]);
    expect(a).toMatchObject({ speed: 10, origin: "http://localhost:3000", route: "Loop" });
  });

  it("refuses missing positionals and bad speeds", () => {
    expect(() => parseSimArgs(["test", "Bus 1"])).toThrow(/Usage/);
    expect(() => parseSimArgs(["test", "Bus 1", "1", "--speed", "0"])).toThrow(/speed/);
    expect(() => parseSimArgs(["test", "Bus 1", "1", "--speed", "abc"])).toThrow(/speed/);
  });
});
