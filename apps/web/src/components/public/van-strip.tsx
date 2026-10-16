"use client";
/** A one-line picture of the loop: the stops on a line, the live vans gliding between them. Pure CSS, no map needed. */
import { cn } from "cn";
import type { PublicMap } from "@/services/public/positions";

export type StripLayout = {
  stops: { id: string; name: string; x: number }[];
  vans: { id: string; name: string; x: number; dir: 1 | -1; onBreak: boolean; atSpot: string | null }[];
};

/**
 * The route serving `spotId` (first one), its distinct stops spread 0..1 in route order, and each van on it at
 * its place along the strip. A van whose place is unknown is left out rather than drawn somewhere wrong.
 */
export function stripLayout(map: Pick<PublicMap, "spots" | "routes" | "vehicles">, spotId: string): StripLayout | null {
  const route = map.routes.find((r) => r.spotIds.includes(spotId));
  if (!route) return null;
  const ids = [...new Set(route.spotIds)];
  const spotById = new Map(map.spots.map((s) => [s.id, s]));
  const stops = ids.map((id, i) => ({
    id,
    name: spotById.get(id)?.shortName ?? "",
    x: ids.length === 1 ? 0 : i / (ids.length - 1),
  }));
  const xOf = new Map(stops.map((s) => [s.id, s.x]));
  const vans: StripLayout["vans"] = [];
  for (const v of map.vehicles) {
    if (v.routeId !== route.id) continue;
    if (v.atSpotId !== null && xOf.has(v.atSpotId)) {
      vans.push({
        id: v.id,
        name: v.name,
        x: xOf.get(v.atSpotId) as number,
        dir: 1,
        onBreak: v.onBreak,
        atSpot: spotById.get(v.atSpotId)?.shortName ?? null,
      });
      continue;
    }
    if (v.legIndex === null || v.legFraction === null) continue;
    const from = xOf.get(route.spotIds[v.legIndex] ?? "");
    const to = xOf.get(route.spotIds[v.legIndex + 1] ?? "");
    if (from === undefined || to === undefined) continue;
    vans.push({
      id: v.id,
      name: v.name,
      x: from + (to - from) * v.legFraction,
      dir: to >= from ? 1 : -1,
      onBreak: v.onBreak,
      atSpot: null,
    });
  }
  return { stops, vans };
}

export function VanStrip({ layout, className }: { layout: StripLayout; className?: string }) {
  return (
    <div className={cn("relative h-14 select-none", className)} aria-hidden>
      {/* the road */}
      <div className="absolute inset-x-3 top-9 h-1 rounded-full bg-ink/15" />
      <div className="absolute inset-x-3 top-9 h-1 rounded-full bg-[repeating-linear-gradient(90deg,transparent_0_10px,var(--marigold)_10px_18px)] opacity-70" />
      {layout.stops.map((s) => (
        <div
          key={s.id}
          className="absolute top-7 flex -translate-x-1/2 flex-col items-center gap-1"
          style={{ left: `calc(12px + (100% - 24px) * ${s.x})` }}
        >
          <span className="size-3 rounded-full border-2 border-paper bg-teal shadow-sm" />
          <span className="text-[11px] font-semibold text-ink-soft">{s.name}</span>
        </div>
      ))}
      {layout.vans.map((v) => (
        <div
          key={v.id}
          className="absolute top-1 flex -translate-x-1/2 flex-col items-center transition-[left] duration-[4000ms] ease-linear motion-reduce:transition-none"
          style={{ left: `calc(12px + (100% - 24px) * ${v.x})` }}
        >
          <span
            className={cn("text-2xl leading-none drop-shadow-sm", !v.atSpot && "van-bob")}
            style={{ transform: v.dir === 1 ? "scaleX(-1)" : undefined }}
          >
            🚐
          </span>
          {v.onBreak && <span className="-mt-1 text-[11px]">☕</span>}
        </div>
      ))}
    </div>
  );
}
