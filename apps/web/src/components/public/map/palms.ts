/**
 * Where the low-poly palms stand: a deterministic scatter along the route corridor (every ~22 m, either side of
 * the road, 10–26 m off it, with gaps), kept clear of the stops so the pins stay readable. Pure; the palm layer
 * builds its instances from this once per data change.
 */
import { routePath } from "./motion";

export const MAX_PALMS = 320;
const STEP_M = 22;
const OFF_MIN_M = 10;
const OFF_MAX_M = 26;
const STOP_CLEAR_M = 40;
/** share of slots left empty, so it reads as a grove, not a fence */
const GAP = 0.3;

export type PalmSite = { lat: number; lng: number; yaw: number; height: number };

/** 0..1 hash of an integer (a small xorshift), stable across runs and machines */
function hash(n: number): number {
  let x = (n + 0x9e3779b9) | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLng = (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

export function palmSites(
  routes: { id: string; path: { lat: number; lng: number }[] }[],
  spots: { lat: number; lng: number }[],
): PalmSite[] {
  const sites: PalmSite[] = [];
  let slot = 0;
  for (const r of routes) {
    if (r.path.length < 2) continue;
    const path = routePath(r.path);
    if (path.lengthM <= 0) continue;
    for (let d = STEP_M / 2; d < path.lengthM; d += STEP_M) {
      slot++;
      const h0 = hash(slot * 4);
      if (h0 < GAP) continue;
      // the road direction here, from the segment the slot falls in
      let i = 0;
      while (i < path.pts.length - 2 && (path.cumM[i + 1] as number) < d) i++;
      const a = path.pts[i] as { lat: number; lng: number };
      const b = path.pts[i + 1] as { lat: number; lng: number };
      const segM = (path.cumM[i + 1] as number) - (path.cumM[i] as number);
      if (segM <= 0) continue;
      const f = (d - (path.cumM[i] as number)) / segM;
      const lat = a.lat + (b.lat - a.lat) * f;
      const lng = a.lng + (b.lng - a.lng) * f;
      const cosLat = Math.cos((lat * Math.PI) / 180);
      // unit vector along the road in metres (east, north), then its right-hand normal
      const e = (b.lng - a.lng) * 111_320 * cosLat;
      const n = (b.lat - a.lat) * 111_320;
      const len = Math.hypot(e, n) || 1;
      const side = hash(slot * 4 + 1) < 0.5 ? -1 : 1;
      const off = OFF_MIN_M + (OFF_MAX_M - OFF_MIN_M) * hash(slot * 4 + 2);
      const dx = ((n / len) * side * off) / (111_320 * cosLat);
      const dy = ((-e / len) * side * off) / 111_320;
      const site = { lat: lat + dy, lng: lng + dx };
      if (spots.some((s) => metres(site, s) < STOP_CLEAR_M)) continue;
      const h3 = hash(slot * 4 + 3);
      sites.push({ ...site, yaw: h3 * 2 * Math.PI, height: 5.5 + 5 * hash(slot * 7 + 5) });
    }
  }
  if (sites.length <= MAX_PALMS) return sites;
  // too many: keep an even spread rather than the first N
  const keep: PalmSite[] = [];
  for (let k = 0; k < MAX_PALMS; k++) keep.push(sites[Math.floor((k * sites.length) / MAX_PALMS)] as PalmSite);
  return keep;
}
