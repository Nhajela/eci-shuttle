import { describe, expect, it } from "vitest";
import { botLink } from "./bot-cta";

describe("botLink", () => {
  it("opens the bot's chat (Start there sends a plain /start: the welcome + updates)", () => {
    expect(botLink("eci_shuttle_bot")).toBe("https://t.me/eci_shuttle_bot");
    expect(botLink("@eci_shuttle_bot")).toBe("https://t.me/eci_shuttle_bot");
  });
  it("no or odd username → no button", () => {
    expect(botLink(null)).toBeNull();
    expect(botLink("")).toBeNull();
    expect(botLink("not a name!")).toBeNull();
  });
});
