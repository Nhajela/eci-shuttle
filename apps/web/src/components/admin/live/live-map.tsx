"use client";
/** admin-live: OpenStreetMap of spots, route paths and vehicles. Leaflet is loaded in the browser only (no SSR). */
import "leaflet/dist/leaflet.css";
import type { LatLng } from "@eci-shuttle/shared";
import type * as L from "leaflet";
import { useEffect, useRef } from "react";

export type MapSpot = { id: string; name: string; lat: number; lng: number; radiusM: number };
export type MapVehicle = {
  id: string;
  name: string;
  colour: string | null;
  lat: number;
  lng: number;
  problem: boolean;
};

const TEAL = "#286c71";
const RED = "#c2410c";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function LiveMap({ spots, paths, vehicles }: { spots: MapSpot[]; paths: LatLng[][]; vehicles: MapVehicle[] }) {
  const el = useRef<HTMLElement>(null);
  const map = useRef<{ L: typeof L; map: L.Map; vehicles: L.LayerGroup } | null>(null);

  const latest = useRef(vehicles);
  latest.current = vehicles;

  // The base map is built once (spots and paths don't move while the page is open), and only when the box has a
  // size: on phones it starts hidden behind the List/Map switch, and Leaflet can't fit bounds in a 0×0 box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: spots/paths are drawn once per mount
  useEffect(() => {
    const box = el.current;
    if (!box) return;
    let cancelled = false;
    let loading = false;
    const init = () =>
      import("leaflet").then((Lmod) => {
        if (cancelled) return;
        const m = Lmod.map(box, { zoomControl: true, attributionControl: true });
        Lmod.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap",
        }).addTo(m);
        for (const p of paths) Lmod.polyline(p, { color: TEAL, weight: 4, opacity: 0.6 }).addTo(m);
        for (const s of spots) {
          Lmod.circle([s.lat, s.lng], { radius: s.radiusM, color: TEAL, weight: 1, fillOpacity: 0.15 })
            .bindTooltip(esc(s.name), { permanent: true, direction: "top", className: "text-xs" })
            .addTo(m);
        }
        const pts: [number, number][] = [
          ...spots.map((s): [number, number] => [s.lat, s.lng]),
          ...paths.flat().map((p): [number, number] => [p.lat, p.lng]),
        ];
        if (pts.length) m.fitBounds(pts, { padding: [32, 32], maxZoom: 16 });
        else m.setView([15.65, 73.72], 13); // Mandrem, Goa
        map.current = { L: Lmod, map: m, vehicles: Lmod.layerGroup().addTo(m) };
        drawVehicles(map.current, latest.current);
      });
    const ro = new ResizeObserver(() => {
      if (map.current) map.current.map.invalidateSize();
      else if (!loading && box.clientWidth > 0) {
        loading = true;
        void init();
      }
    });
    ro.observe(box);
    return () => {
      cancelled = true;
      ro.disconnect();
      map.current?.map.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (map.current) drawVehicles(map.current, vehicles);
  }, [vehicles]);

  return (
    <section
      ref={el}
      className="h-[60vh] min-h-72 w-full overflow-hidden rounded-xl border"
      aria-label="Map of vehicles and spots"
    />
  );
}

function drawVehicles(m: { L: typeof L; vehicles: L.LayerGroup }, vehicles: MapVehicle[]) {
  m.vehicles.clearLayers();
  for (const v of vehicles) {
    m.L.circleMarker([v.lat, v.lng], {
      radius: 10,
      color: v.problem ? RED : "#141b34",
      weight: 3,
      fillColor: v.colour ?? "#e39a2e",
      fillOpacity: 1,
    })
      .bindTooltip(esc(v.name), { permanent: true, direction: "right" })
      .addTo(m.vehicles);
  }
}
