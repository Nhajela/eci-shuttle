/** admin-shell: what AdminMap draws, and the plain list it shows when Leaflet or the tiles can't load. */
import type { LatLng } from "@eci-shuttle/shared";
import { AlertTriangle } from "lucide-react";

export type MapSpot = { id: string; name: string; lat: number; lng: number; radiusM: number };
export type MapMarker = {
  id: string;
  name: string;
  colour: string | null;
  lat: number;
  lng: number;
  problem: boolean;
  /** no signal: the position is a prediction (optional; drawn faded and dashed) */
  estimated?: boolean;
};

/** Points to fit the view to: spots and paths (they don't move); markers only when there is nothing else. */
export function fitPoints(spots: MapSpot[], paths: LatLng[][], markers: MapMarker[]): [number, number][] {
  const fixed = [...spots, ...paths.flat()].map((p): [number, number] => [p.lat, p.lng]);
  return fixed.length ? fixed : markers.map((m): [number, number] => [m.lat, m.lng]);
}

const mapsLink = (p: { lat: number; lng: number }) =>
  `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;

export function MapList({ spots, markers }: { spots: MapSpot[]; markers: MapMarker[] }) {
  if (!spots.length && !markers.length) return <p className="p-3 text-muted-foreground">Nothing to show.</p>;
  const row = "flex min-h-11 items-center gap-2 border-b px-3 py-2 last:border-b-0";
  return (
    <ul className="text-sm">
      {markers.map((m) => (
        <li key={`m:${m.id}`} className={row}>
          <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: m.colour ?? "#e39a2e" }} />
          <span className="min-w-0 flex-1 font-medium">{m.name}</span>
          {m.estimated && <span className="text-muted-foreground">estimated, no signal</span>}
          {m.problem && (
            <span className="flex items-center gap-1 text-orange-800">
              <AlertTriangle className="size-4" aria-hidden /> needs attention
            </span>
          )}
          <a className="underline" href={mapsLink(m)} target="_blank" rel="noreferrer">
            Open
          </a>
        </li>
      ))}
      {spots.map((s) => (
        <li key={`s:${s.id}`} className={`${row} text-muted-foreground`}>
          <span className="min-w-0 flex-1">{s.name}</span>
          <a className="underline" href={mapsLink(s)} target="_blank" rel="noreferrer">
            Open
          </a>
        </li>
      ))}
    </ul>
  );
}
