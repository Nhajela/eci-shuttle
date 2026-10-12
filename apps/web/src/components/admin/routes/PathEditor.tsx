"use client";
import "leaflet/dist/leaflet.css";
import type { LatLng, PathSource } from "@eci-shuttle/shared";
import type * as L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { regeneratePathAction, savePathAction } from "@/app/admin/routes/actions";
import { Button } from "@/components/ui/button";
import { insertVertex, removeVertex } from "./routes";
import { useActionToast } from "./useActionToast";

type MapSpot = { id: string; name: string; lat: number; lng: number; radiusM: number };

const SOURCE: Record<PathSource, string> = {
  osrm: "Generated from the road map",
  straight: "Straight lines (the road map was unavailable). Regenerate or adjust it.",
  manual: "Adjusted by hand",
};

/**
 * The route's path on an OpenStreetMap map, with its spots. Edit mode: drag a point to move it, tap the map to add a
 * bend in the nearest segment, long-press (or right-click) a point to remove it.
 */
export function PathEditor({
  w,
  route,
  spots,
  canEdit,
}: {
  w: string;
  route: { id: string; version: number; path: LatLng[]; pathSource: PathSource };
  spots: MapSpot[];
  canEdit: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<{ L: typeof L; map: L.Map; layer: L.LayerGroup } | null>(null);
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(route.path);
  const [save, saving] = useActionToast(savePathAction, () => setEditing(false));
  const [regenerate, regenerating] = useActionToast(regeneratePathAction);

  // a new version from the server replaces the draft
  useEffect(() => setDraft(route.path), [route.path]);

  // Leaflet needs window, so it loads in the browser only
  // biome-ignore lint/correctness/useExhaustiveDependencies: create the map once; fitBounds uses the first path
  useEffect(() => {
    let cancelled = false;
    let m: L.Map | undefined;
    import("leaflet").then((Lmod) => {
      if (cancelled || !box.current) return;
      const Lf = (Lmod as unknown as { default?: typeof L }).default ?? (Lmod as unknown as typeof L);
      m = Lf.map(box.current, { scrollWheelZoom: false });
      Lf.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(m);
      const pts = [...route.path, ...spots].map((p) => [p.lat, p.lng] as [number, number]);
      if (pts.length) m.fitBounds(pts, { padding: [24, 24] });
      else m.setView([15.66, 73.71], 13); // Mandrem
      map.current = { L: Lf, map: m, layer: Lf.layerGroup().addTo(m) };
      setReady(true);
    });
    return () => {
      cancelled = true;
      m?.remove();
      map.current = null;
    };
  }, []);

  // redraw path, spots and (while editing) the draggable points
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ready` re-runs this once the map (a ref) exists
  useEffect(() => {
    const cur = map.current;
    if (!cur) return;
    const { L: Lf, layer } = cur;
    layer.clearLayers();
    const path = editing ? draft : route.path;
    Lf.polyline(
      path.map((p) => [p.lat, p.lng]),
      { color: "#2563eb", weight: 5, opacity: 0.85 },
    ).addTo(layer);
    for (const s of spots) {
      Lf.circle([s.lat, s.lng], { radius: s.radiusM, color: "#16a34a", weight: 2, fillOpacity: 0.15 })
        .bindTooltip(s.name, { permanent: true, direction: "top", offset: [0, -6] })
        .addTo(layer);
    }
    if (!editing) return;
    const icon = Lf.divIcon({
      className: "",
      html: '<div style="width:18px;height:18px;border-radius:9px;background:#fff;border:3px solid #2563eb"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    draft.forEach((p, i) => {
      Lf.marker([p.lat, p.lng], { icon, draggable: true, keyboard: false })
        .on("dragend", (e) => {
          const ll = (e.target as L.Marker).getLatLng();
          setDraft((d) => d.map((q, k) => (k === i ? { lat: ll.lat, lng: ll.lng } : q)));
        })
        .on("contextmenu", () => setDraft((d) => removeVertex(d, i)))
        .addTo(layer);
    });
  }, [ready, editing, draft, route.path, spots]);

  // tap the map while editing → add a bend
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ready` re-runs this once the map (a ref) exists
  useEffect(() => {
    const m = map.current?.map;
    if (!m || !editing) return;
    const onClick = (e: L.LeafletMouseEvent) =>
      setDraft((d) => insertVertex(d, { lat: e.latlng.lat, lng: e.latlng.lng }));
    m.on("click", onClick);
    return () => {
      m.off("click", onClick);
    };
  }, [ready, editing]);

  const hidden = (
    <>
      <input type="hidden" name="w" value={w} />
      <input type="hidden" name="routeId" value={route.id} />
      <input type="hidden" name="version" value={route.version} />
    </>
  );

  return (
    <div className="flex flex-col gap-2">
      <div ref={box} className="h-80 w-full overflow-hidden rounded-lg bg-muted" />
      <p className="text-xs text-muted-foreground">
        {editing
          ? "Drag a point to move it. Tap the map to add a bend. Long-press a point to remove it."
          : `${SOURCE[route.pathSource]} · ${route.path.length} points`}
      </p>
      {canEdit &&
        (editing ? (
          <form action={save} className="flex gap-2">
            {hidden}
            <input type="hidden" name="path" value={JSON.stringify(draft)} />
            <Button type="submit" size="lg" className="flex-1" disabled={saving}>
              {saving ? "Saving…" : "Save path"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => {
                setDraft(route.path);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="lg" className="flex-1" onClick={() => setEditing(true)}>
              Adjust path
            </Button>
            <form
              action={regenerate}
              className="flex-1"
              onSubmit={(e) => {
                if (route.pathSource === "manual" && !confirm("Replace the hand-adjusted path with a generated one?"))
                  e.preventDefault();
              }}
            >
              {hidden}
              <Button type="submit" variant="outline" size="lg" className="w-full" disabled={regenerating}>
                {regenerating ? "Generating…" : "Regenerate"}
              </Button>
            </form>
          </div>
        ))}
    </div>
  );
}
