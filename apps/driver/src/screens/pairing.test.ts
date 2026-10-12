import { describe, expect, it } from "vitest";
import { parsePairingInput } from "./pairing";

describe("parsePairingInput", () => {
  it("reads the code and origin from the admin QR link", () => {
    expect(parsePairingInput("https://shuttle-test.example.com/pair/482913")).toEqual({
      code: "482913",
      origin: "https://shuttle-test.example.com",
    });
    expect(parsePairingInput(" https://x.example.com/pair/482913/ ")).toEqual({
      code: "482913",
      origin: "https://x.example.com",
    });
  });

  it("accepts 6 typed digits, ignoring spaces and dashes", () => {
    expect(parsePairingInput("482 913")).toEqual({ code: "482913", origin: null });
    expect(parsePairingInput("482-913")).toEqual({ code: "482913", origin: null });
  });

  it("rejects anything else", () => {
    for (const bad of [
      "",
      "12345",
      "1234567",
      "abcdef",
      "https://x.example.com/other/482913",
      "http://x.example.com/pair/482913",
      "ftp://x/pair/482913",
    ])
      expect(parsePairingInput(bad)).toBeNull();
  });
});
