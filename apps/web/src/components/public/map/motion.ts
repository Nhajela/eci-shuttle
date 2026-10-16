/**
 * Smooth motion for map markers: each new fix starts a glide from wherever the marker is drawn right now to the
 * fix, over `durationMs`. Pure; the map samples it every frame with the current time.
 *
 * On its route (the fix carries `alongM`, metres along the route path) a van glides ALONG THE ROAD: through the
 * bends, facing the way the road goes, never backwards for a few metres of GPS jitter, and on a loop forwards
 * through the end back to the start. Off the route (alongM null) it glides straight, as before.
 */

export type Fix = { lat: number; lng: number; headingDeg: number | null; alongM?: number | null };
export type Pose = { lat: number; lng: number; headingDeg: number };
/** A route path measured once: points, metres from the start to each point, total length, loop or not. */
export type RoutePath = {
  pts: { lat: number; lng: number }[];
  cumM: number[];
  lengthM: number;
  loop: boolean;
};
export type Track = {
  from: Pose;
  to: Pose;
  startMs: number;
  durationMs: number;
  /** set while gliding along a route: metres along it, from → to (to may run past the end of a loop) */
  road?: { path: RoutePath; fromM: number; toM: number };
};

/** a step back along the road smaller than this is GPS jitter: the van holds still instead of reversing */
const JITTER_M = 30;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Interpolates compass degrees the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (((b - a) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return (((a + d * t) % 360) + 360) % 360;
}

function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLng = (b.lng - a.lng) * 111_320 * Math.cos(rad((a.lat + b.lat) / 2));
  return Math.hypot(dLat, dLng);
};

/** Measures a route path once (a loop ends within 25 m of where it starts). */
export function routePath(pts: { lat: number; lng: number }[]): RoutePath {
  const cumM = [0];
  for (let i = 1; i < pts.length; i++) cumM.push((cumM[i - 1] as number) + metres(pts[i - 1], pts[i]));
  const lengthM = cumM.at(-1) ?? 0;
  const loop = pts.length > 2 && metres(pts[0], pts.at(-1) as { lat: number; lng: number }) < 25;
  return { pts, cumM, lengthM, loop };
}

/** The point `alongM` metres along the path, facing the road there (a loop wraps; a line clamps to its ends). */
export function pointAt(path: RoutePath, alongM: number): Pose {
  const { pts, cumM, lengthM } = path;
  if (pts.length === 0) return { lat: 0, lng: 0, headingDeg: 0 };
  if (pts.length === 1 || lengthM <= 0) return { ...pts[0], headingDeg: 0 };
  let d = alongM;
  if (path.loop) {
    while (d > lengthM) d -= lengthM;
    while (d < 0) d += lengthM;
  } else d = Math.min(lengthM, Math.max(0, d));
  // the segment that ends at or after d (so the very end of a loop still faces into its last segment)
  let i = 0;
  while (i < pts.length - 2 && (cumM[i + 1] as number) < d) i++;
  const a = pts[i];
  const b = pts[i + 1];
  const segM = (cumM[i + 1] as number) - (cumM[i] as number);
  const f = segM > 0 ? (d - (cumM[i] as number)) / segM : 0;
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, headingDeg: bearing(a, b) };
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Where the marker is drawn at `nowMs`. */
export function sample(track: Track, nowMs: number): Pose {
  const t = track.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - track.startMs) / track.durationMs));
  if (track.road) {
    const { path, fromM, toM } = track.road;
    return pointAt(path, t >= 1 ? toM : fromM + (toM - fromM) * ease(t));
  }
  if (t >= 1) return track.to;
  const k = ease(t);
  return {
    lat: track.from.lat + (track.to.lat - track.from.lat) * k,
    lng: track.from.lng + (track.to.lng - track.from.lng) * k,
    headingDeg: lerpAngle(track.from.headingDeg, track.to.headingDeg, k),
  };
}

/**
 * A new fix: glide from the current drawn pose to it. Without a heading, the fix takes the direction it moved in
 * (or keeps the old heading when it did not move: a parked van must not twitch).
 */
export function retarget(
  prev: Track | undefined,
  fix: Fix,
  nowMs: number,
  durationMs: number,
  path?: RoutePath,
): Track {
  if (path && path.lengthM > 0 && fix.alongM != null) {
    const target = path.loop ? fix.alongM : Math.min(path.lengthM, Math.max(0, fix.alongM));
    const here = prev?.road?.path === path ? roadM(prev, nowMs) : null;
    if (here === null) {
      // first fix, or it just joined the road: place it there (a glide from off-road would cut across)
      const pose = pointAt(path, target);
      return { from: pose, to: pose, startMs: nowMs, durationMs: 0, road: { path, fromM: target, toM: target } };
    }
    let delta = target - here;
    if (path.loop) {
      // the shorter way round the loop
      if (delta < -path.lengthM / 2) delta += path.lengthM;
      if (delta > path.lengthM / 2) delta -= path.lengthM;
    }
    if (delta < 0 && delta > -JITTER_M) delta = 0;
    const toM = here + delta;
    return {
      from: pointAt(path, here),
      to: pointAt(path, toM),
      startMs: nowMs,
      durationMs: delta === 0 ? 0 : durationMs,
      road: { path, fromM: here, toM },
    };
  }
  if (!prev) {
    const pose = { lat: fix.lat, lng: fix.lng, headingDeg: fix.headingDeg ?? 0 };
    return { from: pose, to: pose, startMs: nowMs, durationMs: 0 };
  }
  const from = sample(prev, nowMs);
  const moved = Math.abs(fix.lat - from.lat) > 1e-7 || Math.abs(fix.lng - from.lng) > 1e-7;
  const headingDeg = fix.headingDeg ?? (moved ? bearing(from, fix) : from.headingDeg);
  return { from, to: { lat: fix.lat, lng: fix.lng, headingDeg }, startMs: nowMs, durationMs };
}

/** Metres along the road where a road track is drawn at `nowMs`. */
function roadM(track: Track, nowMs: number): number {
  const road = track.road as NonNullable<Track["road"]>;
  const t = track.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - track.startMs) / track.durationMs));
  return t >= 1 ? road.toM : road.fromM + (road.toM - road.fromM) * ease(t);
}
