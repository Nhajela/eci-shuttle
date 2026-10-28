/**
 * Dead-zone estimates on the client. Between Circle and Namaka there is no mobile signal, so the server predicts a
 * van's place along its route and marks it `estimate`. lat/lng/legIndex/legFraction are then a prediction, not a
 * fix: the map draws such a van ghosted and says so. The field is optional here so the client compiles and works
 * before and after the server sends it. Pure; no lateness anywhere.
 */
import type { PublicMap, PublicVehicle } from "@/services/public/positions";

export type Estimate = { reason: "no_signal"; lastSeenAt: string };
/** a vehicle of GET /api/positions, with the optional dead-zone estimate */
export type MapVehicle = PublicVehicle & { estimate?: Estimate };
export type ClientMap = Omit<PublicMap, "vehicles"> & { vehicles: MapVehicle[] };

export const isEstimated = (v: { estimate?: Estimate }): boolean => v.estimate?.reason === "no_signal";
export const estimatedCount = (vs: { estimate?: Estimate }[]): number => vs.filter(isEstimated).length;

/** The map card's pill. Estimated vans count as on the road, and the pill says so. */
export function summaryCopy(vs: { estimate?: Estimate }[]): string {
  const n = vs.length;
  if (n === 0) return "No shuttle in sight right now";
  const base = n === 1 ? "1 shuttle on the road" : `${n} shuttles on the road`;
  const e = estimatedCount(vs);
  if (e === 0) return base;
  if (e === n) return `${base} · ${n === 1 ? "estimated" : "all estimated"} (no signal)`;
  return `${base} · ${e} estimated (no signal)`;
}

/** The text on a van's label on the map. */
export function vanLabelText(v: { name: string; onBreak: boolean; estimate?: Estimate }): string {
  const parts = [v.onBreak ? `☕ ${v.name}` : v.name];
  if (v.onBreak) parts.push("on a break");
  if (isEstimated(v)) parts.push("no signal", "estimated");
  return parts.join(" · ");
}

/** The map's accessible name: colour is never the only signal. */
export function mapAriaLabel(vs: { name: string; estimate?: Estimate }[]): string {
  const base = "Live map of the shuttle";
  const names = vs.filter(isEstimated).map((v) => `${v.name}: estimated position, no signal.`);
  return names.length ? `${base}. ${names.join(" ")}` : base;
}
