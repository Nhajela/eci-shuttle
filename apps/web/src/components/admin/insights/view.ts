/** admin-insights: pure view helpers for the Insights page (range, heatmap grid, formatting). */
import { type IsoDate, istDate } from "@eci-shuttle/shared";
import type { Insights } from "@/services/learning/insights";
import type { DeadZone } from "@/services/signal/dead-zones";

type Param = string | string[] | undefined;
type SlotCell = Insights["delayBySlot"][number];

const DAY_MS = 86_400_000;
// round-trip so 2026-02-30 is refused, not rolled over
const isDate = (v: Param): v is IsoDate =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && istDate(Date.parse(`${v}T12:00:00+05:30`) || 0) === v;

/** `?from=&to=` (IST dates) → a valid range; default is the last 7 IST days ending today. */
export function insightsRange(p: { from?: Param; to?: Param }, now: Date): { from: IsoDate; to: IsoDate } {
  const to = isDate(p.to) ? p.to : istDate(now);
  const from = isDate(p.from) ? p.from : istDate(Date.parse(`${to}T12:00:00Z`) - 6 * DAY_MS);
  return from <= to ? { from, to } : { from: to, to: from };
}

/** One row per departure slot (time order) with Monday..Sunday cells (null = no departures that day). */
export function heatmap(rows: SlotCell[], spotId: string): { slot: string; days: (SlotCell | null)[] }[] {
  const bySlot = new Map<string, (SlotCell | null)[]>();
  for (const r of rows) {
    if (r.spotId !== spotId) continue;
    const days = bySlot.get(r.slot) ?? Array<SlotCell | null>(7).fill(null);
    days[r.weekday - 1] = r;
    bySlot.set(r.slot, days);
  }
  return [...bySlot].sort(([a], [b]) => a.localeCompare(b)).map(([slot, days]) => ({ slot, days }));
}

/** On time is within 3 min either way (SPEC §6a.5). */
export const heatTone = (avgMin: number): "ok" | "warn" | "bad" =>
  Math.abs(avgMin) <= 3 ? "ok" : Math.abs(avgMin) <= 8 ? "warn" : "bad";

export function fmtDelay(min: number): string {
  const m = Math.round(min);
  return m === 0 ? "on time" : m > 0 ? `+${m} min` : `−${-m} min`;
}

export function fmtDuration(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** One line per stretch without mobile signal (Insights): where, how long, and how it was found. */
export function deadZoneLines(zones: DeadZone[], spotNames: Map<string, string>): string[] {
  return zones.map((z) => {
    const leg = `${spotNames.get(z.fromSpotId) ?? "Unknown spot"} → ${spotNames.get(z.toSpotId) ?? "Unknown spot"}`;
    const length =
      z.startAlongM != null && z.endAlongM != null ? ` for about ${Math.round(z.endAlongM - z.startAlongM)} m` : "";
    const how = z.source === "manual" ? "marked by an admin" : "found from late phone uploads";
    const typical = z.typicalLegS != null ? `, typically ${fmtDuration(z.typicalLegS)}` : "";
    return `${leg}: no signal${length} (${how}${typical})`;
  });
}
