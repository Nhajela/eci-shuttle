/**
 * Smooth motion for map markers: each new fix starts a glide from wherever the marker is drawn right now to the
 * fix, over `durationMs`. Pure; the map samples it every frame with the current time.
 */

export type Fix = { lat: number; lng: number; headingDeg: number | null };
export type Pose = { lat: number; lng: number; headingDeg: number };
export type Track = { from: Pose; to: Pose; startMs: number; durationMs: number };

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

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Where the marker is drawn at `nowMs`. */
export function sample(track: Track, nowMs: number): Pose {
  const t = track.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - track.startMs) / track.durationMs));
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
export function retarget(prev: Track | undefined, fix: Fix, nowMs: number, durationMs: number): Track {
  if (!prev) {
    const pose = { lat: fix.lat, lng: fix.lng, headingDeg: fix.headingDeg ?? 0 };
    return { from: pose, to: pose, startMs: nowMs, durationMs: 0 };
  }
  const from = sample(prev, nowMs);
  const moved = Math.abs(fix.lat - from.lat) > 1e-7 || Math.abs(fix.lng - from.lng) > 1e-7;
  const headingDeg = fix.headingDeg ?? (moved ? bearing(from, fix) : from.headingDeg);
  return { from, to: { lat: fix.lat, lng: fix.lng, headingDeg }, startMs: nowMs, durationMs };
}
