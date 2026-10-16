import type { Metadata } from "next";

const TITLE = "ECI Shuttle · where's the shuttle?";
const DESCRIPTION =
  "Live Riva ↔ Circle shuttle for Edge City India 2026. See where the van is, when it reaches you, and when the next one leaves.";
const OG_ALT =
  "A painted white Traveller shuttle with a marigold garland on a palm-lined Goan village road at golden hour";

/** Site-wide metadata. `origin` is PUBLIC_ORIGIN when known; undefined at build time (env is validated on first use). */
export function siteMetadata(origin: string | undefined): Metadata {
  return {
    metadataBase: origin ? new URL(origin) : undefined,
    title: { default: TITLE, template: "%s · ECI Shuttle" },
    description: DESCRIPTION,
    openGraph: {
      type: "website",
      siteName: "ECI Shuttle",
      title: "Where's the shuttle?",
      description: DESCRIPTION,
      images: [{ url: "/og.jpg", width: 1200, height: 630, alt: OG_ALT }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Where's the shuttle?",
      description: DESCRIPTION,
      images: ["/og.jpg"],
    },
  };
}
