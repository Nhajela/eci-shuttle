/** admin-routes: pure helpers for the Routes page (leg rows, spot order, path edits). */
import { LatLng } from "@eci-shuttle/shared";
import { z } from "zod";

type Names = Record<string, string>;

const nameOf = (names: Names, id: string) => names[id] ?? "Unknown spot";

export function formatLeg(seconds: number | null | undefined): string {
  if (seconds == null) return "not learned yet";
  return seconds < 60 ? "under 1 min" : `${Math.round(seconds / 60)} min`;
}

export type LegRow = { from: string; to: string; time: string; learned: boolean };

/**
 * One row per leg; typicalLegS[i] is the learned median for spotIds[i] → spotIds[i+1] (null = unknown), and
 * legSamples[i] how many trips it was learned from.
 */
export function legRows(
  route: { spotIds: string[]; typicalLegS: (number | null)[]; legSamples?: number[] },
  names: Names,
): LegRow[] {
  return route.spotIds.slice(1).map((to, i) => {
    const s = route.typicalLegS[i];
    const n = route.legSamples?.[i];
    const time = s != null && n ? `${formatLeg(s)} (${n} ${n === 1 ? "trip" : "trips"})` : formatLeg(s);
    return { from: nameOf(names, route.spotIds[i]), to: nameOf(names, to), time, learned: s != null };
  });
}

export const spotChain = (spotIds: string[], names: Names) => spotIds.map((id) => nameOf(names, id)).join(" → ");

export function moveItem<T>(list: T[], i: number, delta: -1 | 1): T[] {
  const j = i + delta;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export const removeVertex = (path: LatLng[], i: number): LatLng[] =>
  path.length <= 2 ? path : path.filter((_, k) => k !== i);

/** Squared distance from p to segment a–b in degrees: planar is fine at a few km. */
function segDist2(p: LatLng, a: LatLng, b: LatLng): number {
  const dx = b.lng - a.lng;
  const dy = b.lat - a.lat;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len)) : 0;
  return (a.lng + t * dx - p.lng) ** 2 + (a.lat + t * dy - p.lat) ** 2;
}

/** Insert p into the path segment nearest to it (tap on the map while editing to add a bend). */
export function insertVertex(path: LatLng[], p: LatLng): LatLng[] {
  let best = 0;
  for (let i = 1; i < path.length - 1; i++)
    if (segDist2(p, path[i], path[i + 1]) < segDist2(p, path[best], path[best + 1])) best = i;
  return [...path.slice(0, best + 1), p, ...path.slice(best + 1)];
}

/**
 * The route form's wait fields as planned_dwell_s seconds: "waitMin" = every stop ("*"), "waitMin:<spotId>" = that
 * stop. Blank = no planned wait there. undefined when the form has no wait fields (leave the plan alone).
 */
export function parseWaits(fd: FormData): Record<string, number> | undefined {
  if (!fd.has("waitMin")) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of fd) {
    if (!k.startsWith("waitMin") || String(v).trim() === "") continue;
    out[k === "waitMin" ? "*" : k.slice("waitMin:".length)] = Math.round(Number(v) * 60);
  }
  return out;
}

const PathJson = z.array(LatLng);

/** The hidden `path` form field: a JSON list of {lat, lng}, or null when it isn't one. */
export function parsePath(raw: FormDataEntryValue | null): LatLng[] | null {
  if (typeof raw !== "string") return null;
  try {
    const r = PathJson.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
