import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("env", () => {
  it("strips the trailing slash from PUBLIC_ORIGIN", () => {
    process.env.PUBLIC_ORIGIN = "https://eci-shuttle.example.com/";
    expect(env.origin()).toBe("https://eci-shuttle.example.com");
  });

  it("splits TOKEN_SECRETS for rotation", () => {
    process.env.TOKEN_SECRETS = `${"a".repeat(32)}, ${"b".repeat(32)}`;
    expect(env.tokenSecrets()).toEqual(["a".repeat(32), "b".repeat(32)]);
  });

  it("names the missing variable", () => {
    delete process.env.SESSION_SECRET;
    expect(() => env.sessionSecret()).toThrow(/SESSION_SECRET/);
  });

  it("PINGS_DELETE_AFTER is an optional IST date", () => {
    delete process.env.PINGS_DELETE_AFTER;
    expect(env.pingsDeleteAfter()).toBeUndefined();
    process.env.PINGS_DELETE_AFTER = "2026-11-02";
    expect(env.pingsDeleteAfter()).toBe("2026-11-02");
    process.env.PINGS_DELETE_AFTER = "after the event";
    expect(() => env.pingsDeleteAfter()).toThrow(/PINGS_DELETE_AFTER/);
  });

  it("EXPO_ACCESS_TOKEN is optional", () => {
    delete process.env.EXPO_ACCESS_TOKEN;
    expect(env.expoAccessToken()).toBeUndefined();
  });
});
