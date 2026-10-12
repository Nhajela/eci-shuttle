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

/** One row per leg; typicalLegS[i] is the learned median for spotIds[i] → spotIds[i+1] (null = unknown). */
export function legRows(route: { spotIds: string[]; typicalLegS: (number | null)[] }, names: Names): LegRow[] {
  return route.spotIds.slice(1).map((to, i) => {
    const s = route.typicalLegS[i];
    return { from: nameOf(names, route.spotIds[i]), to: nameOf(names, to), time: formatLeg(s), learned: s != null };
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
