import { describe, expect, it } from "vitest";
import { siteMetadata } from "./site-metadata";

describe("siteMetadata", () => {
  it("points OpenGraph and Twitter at /og.jpg with alt text", () => {
    const m = siteMetadata("https://eci-shuttle.example.com");
    expect(m.metadataBase?.toString()).toBe("https://eci-shuttle.example.com/");
    const og = m.openGraph as { images: { url: string; width: number; height: number; alt: string }[] };
    expect(og.images[0]).toMatchObject({ url: "/og.jpg", width: 1200, height: 630 });
    expect(og.images[0]?.alt).toMatch(/shuttle/i);
    const tw = m.twitter as { card: string; images: string[] };
    expect(tw.card).toBe("summary_large_image");
    expect(tw.images).toEqual(["/og.jpg"]);
  });

  it("works without a known origin (next build has no env)", () => {
    const m = siteMetadata(undefined);
    expect(m.metadataBase).toBeUndefined();
    expect(m.title).toMatchObject({ template: "%s · ECI Shuttle" });
  });

  it("never mentions lateness to attendees", () => {
    expect(JSON.stringify(siteMetadata("https://x.example"))).not.toMatch(/\blate\b/i);
  });
});
