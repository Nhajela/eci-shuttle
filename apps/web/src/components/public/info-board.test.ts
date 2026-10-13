import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InfoBoard } from "./info-board";

const html = (md: string | null) => renderToStaticMarkup(createElement(InfoBoard, { md }));

describe("InfoBoard", () => {
  it("renders nothing without info", () => {
    expect(html(null)).toBe("");
    expect(html("   ")).toBe("");
  });

  it("renders markdown: headings, bold, lists, links in a new tab", () => {
    const out = html("## Nanu\n\n**Pickup 08:00** daily\n\n- Riva\n- Circle\n\n[Map](https://maps.example/x)");
    expect(out).toContain('aria-label="Info"');
    expect(out).toMatch(/<h2[^>]*>Nanu<\/h2>/);
    expect(out).toContain("<strong>Pickup 08:00</strong>");
    expect(out).toMatch(/<li>Riva<\/li>/);
    expect(out).toMatch(/<a href="https:\/\/maps.example\/x" target="_blank" rel="noopener noreferrer"[^>]*>Map<\/a>/);
  });

  it("never renders raw HTML or javascript: links", () => {
    const out = html("<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("javascript:");
  });
});
