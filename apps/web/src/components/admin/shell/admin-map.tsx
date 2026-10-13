"use client";
/**
 * admin-shell: the shared OpenStreetMap of spots, route paths and markers (vehicles). Leaflet loads in the browser
 * only; if it or the tiles fail, a plain list of the same things is shown instead. Import with
 * `dynamic(() => import(".../admin-map").then((m) => m.AdminMap), { ssr: false })`.
 */
import "leaflet/dist/leaflet.css";
import type { LatLng } from "@eci-shuttle/shared";
import type * as L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { fitPoints, MapList, type MapMarker, type MapSpot } from "./admin-map-list";

export type { MapMarker, MapSpot };

const TEAL = "#286c71";
const RED = "#c2410c";
const MANDREM: [number, number] = [15.65, 73.72];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Live = { L: typeof L; map: L.Map; markers: L.LayerGroup };

export function AdminMap({
  spots,
  paths = [],
  markers = [],
  label = "Map",
}: {
  spots: MapSpot[];
  paths?: LatLng[][];
  markers?: MapMarker[];
  label?: string;
}) {
  const el = useRef<HTMLElement>(null);
  const map = useRef<Live | null>(null);
  const [failed, setFailed] = useState(false);

  const latest = useRef(markers);
  latest.current = markers;

  // The base map is built once (spots and paths don't move while the page is open), and only when the box has a
  // size: on phones it often starts hidden behind a List/Map switch, and Leaflet can't fit bounds in a 0×0 box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: spots/paths are drawn once per mount
  useEffect(() => {
    const box = el.current;
    if (!box) return;
    let cancelled = false;
    let loading = false;
    const init = () =>
      import("leaflet")
        .then((Lmod) => {
          if (cancelled) return;
          const m = Lmod.map(box, { zoomControl: true, attributionControl: true });
          let tileErrors = 0;
          Lmod.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: "&copy; OpenStreetMap",
          })
            .on("tileload", () => {
              tileErrors = -Infinity; // one tile loaded: the network works
            })
            .on("tileerror", () => {
              if (++tileErrors >= 4) setFailed(true);
            })
            .addTo(m);
          for (const p of paths) Lmod.polyline(p, { color: TEAL, weight: 4, opacity: 0.6 }).addTo(m);
          for (const s of spots) {
            Lmod.circle([s.lat, s.lng], { radius: s.radiusM, color: TEAL, weight: 1, fillOpacity: 0.15 })
              .bindTooltip(esc(s.name), { permanent: true, direction: "top", className: "text-xs" })
              .addTo(m);
          }
          const pts = fitPoints(spots, paths, latest.current);
          if (pts.length) m.fitBounds(pts, { padding: [32, 32], maxZoom: 16 });
          else m.setView(MANDREM, 13);
          map.current = { L: Lmod, map: m, markers: Lmod.layerGroup().addTo(m) };
          drawMarkers(map.current, latest.current);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
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
    if (map.current) drawMarkers(map.current, markers);
  }, [markers]);

  if (failed)
    return (
      <section className="w-full overflow-hidden rounded-xl border" aria-label={label}>
        <p className="border-b bg-muted px-3 py-2 text-sm text-muted-foreground">The map didn't load. As a list:</p>
        <MapList spots={spots} markers={markers} />
      </section>
    );
  return <section ref={el} className="h-[60vh] min-h-72 w-full overflow-hidden rounded-xl border" aria-label={label} />;
}

function drawMarkers(m: Live, markers: MapMarker[]) {
  m.markers.clearLayers();
  for (const v of markers) {
    m.L.circleMarker([v.lat, v.lng], {
      radius: 10,
      color: v.problem ? RED : "#141b34",
      weight: 3,
      fillColor: v.colour ?? "#e39a2e",
      fillOpacity: 1,
    })
      .bindTooltip(esc(v.name), { permanent: true, direction: "right" })
      .addTo(m.markers);
  }
}
