/**
 * Real-browser check at phone width: the spot toggle must never scroll the page sideways.
 * Server-renders StatusView, compiles the app's Tailwind CSS, and measures in headless Chromium.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PublicSpot, PublicStatus } from "@eci-shuttle/shared";
import tailwind from "@tailwindcss/postcss";
import { type Browser, chromium } from "playwright-core";
import postcss from "postcss";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StatusView } from "./status-view";

const spot = (spotId: string, name: string, shortName: string): PublicSpot => ({
  spotId,
  name,
  shortName,
  notices: [],
  answers: [],
  schedule: { notices: [], rows: [], loops: [] },
});

const status: PublicStatus = {
  workspace: { slug: "test", name: "Edge City", isLive: true },
  generatedAt: "2026-10-12T04:00:00.000Z",
  notices: [],
  spots: [
    spot("riva", "Riva Resort", "Riva"),
    spot("circle", "The Circle", "Circle"),
    spot("party", "Party venue", "Party"),
    // no shortName: falls back to the full name
    spot("shack", "Mandrem Beach Shack by the Lighthouse", ""),
  ],
};

let browser: Browser | null = null;

beforeAll(async () => {
  // ponytail: uses a cached Playwright Chromium or the installed Chrome; skips if neither (never downloads)
  browser = await chromium
    .launch()
    .catch(() => chromium.launch({ channel: "chrome" }))
    .catch(() => null);
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

describe("StatusView at 390px", () => {
  it("4 spots, one without a shortName, do not scroll the page sideways", async (ctx) => {
    if (!browser) return ctx.skip("no Chromium available");
    const cssPath = fileURLToPath(new URL("../../app/globals.css", import.meta.url));
    const base = fileURLToPath(new URL("../../..", import.meta.url));
    const css = await postcss([tailwind({ base })]).process(readFileSync(cssPath, "utf8"), { from: cssPath });
    const body = renderToString(createElement(StatusView, { initial: status, slug: "test", initialSpotId: "riva" }));

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html><html><head><style>${css.css}</style></head><body>${body}</body></html>`);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(client);
    await page.close();
  }, 60_000);
});
