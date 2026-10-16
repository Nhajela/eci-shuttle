/**
 * Illustrations for the attendee page, in apps/web/public/illustrations (webp, made separately). A missing file
 * simply isn't rendered, so the page is whole while the art is still being painted. Server only (fs).
 */
import fs from "node:fs";
import path from "node:path";

export type PublicArt = {
  /** painterly hero, ~1600×900 and ~900×1200: the top of the page on wide / narrow screens */
  heroWide: string | null;
  heroTall: string | null;
  /** full scene behind the page, ~1600×900 */
  sceneWide: string | null;
  /** transparent parallax layers under illustrations/scene/, back to front (sky, far, mid, road, van …) */
  sceneLayers: string[];
};

const HERO_WIDE = "hero-wide.webp";
const HERO_TALL = "hero-tall.webp";
const SCENE_WIDE = "scene-wide.webp";
/** drawn back to front; any file present is used, in this order, then any others alphabetically */
const LAYER_ORDER = ["sky", "sun", "sea", "far", "mid", "palms", "road", "van", "near", "front"];

const cache = new Map<string, boolean | string[]>();
const fresh = process.env.NODE_ENV !== "production";

function publicDir(): string {
  // next dev / next start run from apps/web; the standalone server chdirs there too
  return path.join(process.cwd(), "public", "illustrations");
}

function exists(file: string): boolean {
  if (fresh || !cache.has(file)) cache.set(file, fs.existsSync(path.join(publicDir(), file)));
  return cache.get(file) === true;
}

function layers(): string[] {
  if (!fresh && cache.has("scene/")) return cache.get("scene/") as string[];
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(path.join(publicDir(), "scene"))
      .filter((f) => /\.(webp|png)$/i.test(f))
      .sort((a, b) => {
        const rank = (f: string) => {
          const i = LAYER_ORDER.findIndex((k) => f.toLowerCase().startsWith(k));
          return i === -1 ? LAYER_ORDER.length : i;
        };
        return rank(a) - rank(b) || a.localeCompare(b);
      });
  } catch {
    files = [];
  }
  cache.set("scene/", files);
  return files;
}

export function publicArt(): PublicArt {
  return {
    heroWide: exists(HERO_WIDE) ? `/illustrations/${HERO_WIDE}` : null,
    heroTall: exists(HERO_TALL) ? `/illustrations/${HERO_TALL}` : null,
    sceneWide: exists(SCENE_WIDE) ? `/illustrations/${SCENE_WIDE}` : null,
    sceneLayers: layers().map((f) => `/illustrations/scene/${f}`),
  };
}
