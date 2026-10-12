"use client";
/** admin-spots: Leaflet + OSM map of spot geofences. Tap to place the pin (onPick) or tap a circle to open it (onSelect). */
import "leaflet/dist/leaflet.css";
import type { LatLng } from "@eci-shuttle/shared";
import type * as Leaflet from "leaflet";
import { useEffect, useRef } from "react";
import { DEFAULT_CENTER } from "./overlap";

export type MapSpot = LatLng & { id: string; name: string; radiusM: number };

type Props = {
  spots: MapSpot[];
  /** the spot being placed or edited: drawn as a pin plus its circle */
  draft?: (LatLng & { radiusM: number }) | null;
  onPick?: (p: LatLng) => void;
  onSelect?: (id: string) => void;
  className?: string;
};

export function SpotMap({ spots, draft, onPick, onSelect, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const fitted = useRef(false);
  // latest callbacks without re-binding Leaflet handlers
  const cb = useRef({ onPick, onSelect, draw: () => {} });

  // Leaflet touches window on import, so it loads in the browser only.
  useEffect(() => {
    let cancelled = false;
    import("leaflet").then((mod) => {
      if (cancelled || !el.current) return;
      L.current = mod;
      const m = mod.map(el.current, { zoomControl: true }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 14);
      mod
        .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        })
        .addTo(m);
      m.on("click", (e: Leaflet.LeafletMouseEvent) => cb.current.onPick?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
      layer.current = mod.layerGroup().addTo(m);
      map.current = m;
      cb.current.draw();
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  function draw() {
    const mod = L.current;
    const m = map.current;
    const g = layer.current;
    if (!mod || !m || !g) return;
    g.clearLayers();
    for (const s of spots) {
      mod
        .circle([s.lat, s.lng], { radius: s.radiusM, color: "#64748b", weight: 2, fillOpacity: 0.15 })
        .bindTooltip(s.name, { permanent: spots.length <= 12, direction: "top" })
        .on("click", (e) => {
          if (!cb.current.onSelect) return; // in the editor a tap on another circle still places the pin
          mod.DomEvent.stopPropagation(e);
          cb.current.onSelect(s.id);
        })
        .addTo(g);
    }
    if (draft) {
      mod
        .circle([draft.lat, draft.lng], { radius: draft.radiusM, color: "#2563eb", weight: 3, fillOpacity: 0.2 })
        .addTo(g);
      mod
        .circleMarker([draft.lat, draft.lng], {
          radius: 8,
          color: "#fff",
          weight: 3,
          fillColor: "#2563eb",
          fillOpacity: 1,
        })
        .addTo(g);
    }
    if (!fitted.current) {
      fitted.current = true;
      if (draft) m.setView([draft.lat, draft.lng], 17);
      else if (spots.length) m.fitBounds(mod.latLngBounds(spots.map((s) => [s.lat, s.lng])).pad(0.3), { maxZoom: 17 });
    }
  }

  cb.current = { onPick, onSelect, draw };

  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw whenever what is shown changes
  useEffect(draw, [spots, draft?.lat, draft?.lng, draft?.radiusM]);

  /** Recentre on the pin when it moves by "use my location" (taps don't need it: the pin is where you tapped). */
  useEffect(() => {
    if (draft && map.current && !map.current.getBounds().contains([draft.lat, draft.lng]))
      map.current.setView([draft.lat, draft.lng], Math.max(map.current.getZoom(), 17));
  }, [draft?.lat, draft?.lng, draft]);

  return (
    <div
      ref={el}
      role="application"
      aria-label={onPick ? "Map: tap to place the spot" : "Map of spots"}
      className={`isolate z-0 rounded-lg border ${className ?? "h-72"}`}
    />
  );
}
