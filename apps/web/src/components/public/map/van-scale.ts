/**
 * How big the shuttle draws on screen. A real 5.6 m van is a 1 px dot at the route overview and 20 px at zoom 18,
 * so the map exaggerates it: a readable floor when zoomed out, growing steadily as you zoom in (so pinching in
 * makes it bigger, like a real thing), and converging on life size when zoomed right in. Pure; the layer calls it
 * every frame.
 */

export const VAN_LENGTH_M = 5.6;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;

/** [zoom, on-screen length in CSS px] — geometric between anchors, flat beyond the ends */
const ANCHORS: [number, number][] = [
  [13, 36],
  [14, 40],
  [16, 60],
  [18, 96],
  [20, 130],
];

/** Ground metres per CSS px at this zoom and latitude (512 px tiles). */
export function metersPerPx(zoom: number, lat: number): number {
  return (Math.cos((lat * Math.PI) / 180) * EARTH_CIRCUMFERENCE_M) / (512 * 2 ** zoom);
}

/** The length the van should read on screen at this zoom, in CSS px. */
export function vanScreenPx(zoom: number): number {
  const first = ANCHORS[0] as [number, number];
  const last = ANCHORS[ANCHORS.length - 1] as [number, number];
  if (zoom <= first[0]) return first[1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < ANCHORS.length; i++) {
    const [z1, p1] = ANCHORS[i] as [number, number];
    const [z0, p0] = ANCHORS[i - 1] as [number, number];
    if (zoom <= z1) {
      const t = (zoom - z0) / (z1 - z0);
      return p0 * (p1 / p0) ** t;
    }
  }
  return last[1];
}

/** Model-space multiplier (metres → exaggerated metres) that draws the van `vanScreenPx` long; never below 1. */
export function vanScreenScale(zoom: number, lat: number): number {
  return Math.max(1, (vanScreenPx(zoom) * metersPerPx(zoom, lat)) / VAN_LENGTH_M);
}

/** How far above the van's ground point its name label sits, in CSS px, for a van `lengthPx` long. */
export function vanLabelOffsetPx(lengthPx: number): number {
  return Math.round(0.42 * lengthPx + 10);
}

/** The palms' exaggeration: the square root of the van's, so trees stay trees next to it at every zoom. */
export function treeScreenScale(zoom: number, lat: number): number {
  return Math.sqrt(vanScreenScale(zoom, lat));
}
