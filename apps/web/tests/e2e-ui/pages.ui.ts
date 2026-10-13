/**
 * SPEC §7: every admin page and the public page at 390×844 in real Chrome. A page fails when it scrolls sideways
 * (document.scrollingElement.scrollWidth > clientWidth) or a control sits partly off-screen with no scroll container
 * to reach it. Every page leaves a full-page screenshot in tests/e2e-ui/output/.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const OUT = fileURLToPath(new URL("./output/", import.meta.url));
const origin = inject("uiOrigin");
const slug = inject("uiSlug");

/** [screenshot name, path]. No page needs more than the admin role, so one admin session opens them all. */
const ADMIN = [
  "live",
  "schedule",
  "notices",
  "phones",
  "vehicles",
  "routes",
  "spots",
  "people",
  "activity",
  "insights",
  "workspaces",
].map((p) => [`admin-${p}`, `/admin/${p}`] as const);
const PUBLIC = [
  ["public", "/"],
  ["public-slug", `/w/${slug}`],
] as const;
/**
 * Known failures: reported, not fixed here (product pages belong to their modules). `it.fails` turns green the day a
 * page is fixed, which flags the entry for removal.
 */
const KNOWN_FAILURES: Record<string, string> = {};

type Layout = { scrollWidth: number; clientWidth: number; clipped: string[] };

/** Runs in the page. */
function measure(): Layout {
  const doc = document.scrollingElement ?? document.documentElement;
  const W = doc.clientWidth;
  const sel =
    'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="tab"],[role="link"],[role="checkbox"],[role="switch"]';
  const scrollsX = (el: Element) => {
    const o = getComputedStyle(el).overflowX;
    return (o === "auto" || o === "scroll") && el.scrollWidth > el.clientWidth;
  };
  const clipped = [...document.querySelectorAll(sel)].filter((el) => {
    if (el.closest(".leaflet-pane")) return false; // map markers live on a pannable canvas
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || getComputedStyle(el).visibility === "hidden") return false; // hidden, sr-only
    if (r.left >= -1 && r.right <= W + 1) return false;
    for (let p = el.parentElement; p && p !== doc; p = p.parentElement) if (scrollsX(p)) return false;
    return true;
  });
  return {
    scrollWidth: doc.scrollWidth,
    clientWidth: W,
    clipped: clipped.map((el) => {
      const r = el.getBoundingClientRect();
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40);
      return `<${el.tagName.toLowerCase()}> "${label}" at x=${Math.round(r.left)}..${Math.round(r.right)}`;
    }),
  };
}

let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch({ channel: "chrome" }); // the installed Chrome; never downloads a browser
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await context.addCookies([{ ...inject("uiSession"), url: origin }]);
  // nothing leaves the machine (map tiles, fonts, analytics)
  await context.route(
    (url) => url.origin !== origin,
    (r) => r.abort(),
  );
});

afterAll(async () => {
  await browser?.close();
});

describe("phone layout at 390×844", () => {
  it("the check itself catches sideways scroll and clipped controls, and ignores scroll strips", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`<body style="margin:0">
        <div style="width:500px">wide</div>
        <button style="position:absolute;left:350px;width:80px">Save</button>
        <div style="overflow-x:auto;width:390px"><div style="width:800px"><button style="margin-left:600px">Tab</button></div></div>
        <a href="#" style="position:absolute;width:1px;height:1px;overflow:hidden;left:-10px">sr-only</a>
      </body>`);
      const layout = await page.evaluate(measure);
      expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
      expect(layout.clipped).toEqual([expect.stringContaining('<button> "Save"')]);
    } finally {
      await page.close();
    }
  });

  for (const [name, path] of [...ADMIN, ...PUBLIC]) {
    const run = KNOWN_FAILURES[name] ? it.fails : it;
    run(`${path} has no sideways scroll and no clipped controls`, async () => {
      const page = await context.newPage();
      try {
        const res = await page.goto(origin + path, { waitUntil: "load" });
        expect(res?.status(), "HTTP status").toBe(200);
        expect(new URL(page.url()).pathname, "not bounced to login").toBe(path);
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {}); // live pages poll forever
        await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
        const layout = await page.evaluate(measure);
        expect(layout.clipped, "controls clipped off-screen").toEqual([]);
        expect(layout.scrollWidth, "page scrolls sideways").toBeLessThanOrEqual(layout.clientWidth);
      } finally {
        await page.close();
      }
    });
  }
});
