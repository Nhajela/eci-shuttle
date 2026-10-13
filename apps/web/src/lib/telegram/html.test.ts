import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html";

describe("escapeHtml", () => {
  it("escapes the characters Telegram HTML treats as markup", () => {
    expect(escapeHtml(`<b>Tom & "Jerry"</b>`)).toBe("&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;");
  });

  it("escapes & first, so entities are not double-escaped into nonsense", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});
