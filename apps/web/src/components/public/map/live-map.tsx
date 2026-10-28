"use client";
/**
 * The public 3D map (SPEC §6): OpenFreeMap vector tiles (keyless) through MapLibre, pitched, repainted into the
 * page's golden-hour world (world.ts: sky, fog, light, teal sea, warm buildings), the route as a glowing line whose
 * dashes flow in the direction of travel, stop pins over ground pads, low-poly palms along the corridor
 * (palm-layer.ts) and the 3D vans (van-layer.ts), which grow as you zoom in (van-scale.ts). Browser only: import
 * through next/dynamic with ssr: false (public-map.tsx), which also owns polling, the follow toggle and the
 * full-screen state. If WebGL or the tiles fail, `onFail` fires and the parent shows nothing broken.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { LngLatBounds, Marker, Map as MlMap, setWorkerUrl } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { isEstimated, mapAriaLabel, type ClientMap as PublicMap, vanLabelText } from "./estimate";
import { PalmLayer } from "./palm-layer";
import { palmSites } from "./palms";
import { type VanFix, VanLayer } from "./van-layer";
import { vanLabelOffsetPx, vanScreenPx } from "./van-scale";
import { applyWorld } from "./world";

// maplibre 6 looks for its worker next to its own bundle, which a bundled app does not have: serve the file as a
// static asset of this app instead (self-contained; maplibre-gl-shared.mjs is empty)
const WORKER_URL = new URL("../../../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url);

const LIGHT_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const DARK_STYLE = "https://tiles.openfreemap.org/styles/fiord";
const MANDREM: [number, number] = [73.7165, 15.66];
const GLIDE_MS = 4000;
const LOAD_TIMEOUT_MS = 20_000;
const PITCH = 60;
const MAX_PITCH = 78;
const MAX_ZOOM = 20;
/** the dashes march one step every DASH_MS; the sequence is one cycle of a 4-unit dash sliding forward */
const DASH_MS = 70;
const DASH_SEQUENCE = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
];

type Live = {
  map: MlMap;
  vans: VanLayer;
  palms: PalmLayer;
  /** the routes the palms were planted for (replanted only when they change) */
  palmKey: string;
  labels: Map<string, Marker>;
  /** the label offset in use, so it is only reset when the zoom moves it */
  labelPx: number;
  stops: Map<string, Marker>;
  raf: number;
  dashStep: number;
  dashAt: number;
  loaded: boolean;
  follow: boolean;
};

export type LiveMapProps = {
  data: PublicMap;
  dark: boolean;
  reducedMotion: boolean;
  /** keep the first shuttle centred */
  follow: boolean;
  /** the box changed size (full screen) */
  expanded: boolean;
  /** the person dragged or zoomed the map themselves (the card then stops following) */
  onUserMove?: () => void;
  onReady?: () => void;
  onFail?: () => void;
  className?: string;
};

const rad = (d: number) => (d * Math.PI) / 180;
const bearing = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

function routeGeoJson(data: PublicMap, dark: boolean): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.routes
      .filter((r) => r.path.length > 1)
      .map((r) => ({
        type: "Feature",
        properties: { colour: r.colour ?? (dark ? "#5fb0b5" : "#286c71") },
        geometry: { type: "LineString", coordinates: r.path.map((p) => [p.lng, p.lat]) },
      })),
  };
}

/** the ground pads under the stop pins: a teal disc, marigold while a shuttle is there */
function stopsGeoJson(data: PublicMap): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.spots.map((s) => ({
      type: "Feature",
      properties: { here: data.vehicles.some((v) => v.atSpotId === s.id) },
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
    })),
  };
}

function boundsOf(data: PublicMap): LngLatBounds | null {
  const pts = [...data.spots, ...data.routes.flatMap((r) => r.path)];
  if (!pts.length) return null;
  const b = new LngLatBounds();
  for (const p of pts) b.extend([p.lng, p.lat]);
  return b;
}

function stopElement(name: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "eci-stop";
  const pin = document.createElement("span");
  pin.className = "eci-stop-pin";
  pin.textContent = name;
  const stem = document.createElement("span");
  stem.className = "eci-stop-stem";
  const dot = document.createElement("span");
  dot.className = "eci-stop-dot";
  el.append(pin, stem, dot);
  return el;
}

function labelElement(): HTMLElement {
  const el = document.createElement("div");
  el.className = "eci-van-label";
  return el;
}

function vanFixes(data: PublicMap): VanFix[] {
  return data.vehicles.map((v) => ({
    id: v.id,
    lat: v.lat,
    lng: v.lng,
    headingDeg: v.headingDeg,
    colour: v.colour,
    routeId: v.routeId,
    alongM: v.alongM,
    estimated: isEstimated(v),
  }));
}

export function LiveMap({
  data,
  dark,
  reducedMotion,
  follow,
  expanded,
  onUserMove,
  onReady,
  onFail,
  className,
}: LiveMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const latest = useRef({ data, follow, onUserMove, onReady, onFail });
  latest.current = { data, follow, onUserMove, onReady, onFail };

  // the map is built once per theme / motion preference; data flows in through the effect below
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const probe = document.createElement("canvas").getContext("webgl2");
    if (!probe) {
      latest.current.onFail?.();
      return;
    }
    const touch = matchMedia("(pointer: coarse)").matches;
    setWorkerUrl(WORKER_URL.href);
    let map: MlMap;
    try {
      map = new MlMap({
        container: el,
        style: dark ? DARK_STYLE : LIGHT_STYLE,
        center: MANDREM,
        zoom: 13.5,
        pitch: 0,
        bearing: 0,
        maxPitch: MAX_PITCH,
        minZoom: 11,
        maxZoom: MAX_ZOOM,
        attributionControl: { compact: true },
        cooperativeGestures: touch,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        fadeDuration: reducedMotion ? 0 : 300,
        touchPitch: true,
      });
    } catch {
      latest.current.onFail?.();
      return;
    }
    const vans = new VanLayer({ glideMs: GLIDE_MS, animate: !reducedMotion, dark });
    const palms = new PalmLayer({ animate: !reducedMotion, dark });
    if (process.env.NODE_ENV !== "production")
      Object.assign(window as unknown as Record<string, unknown>, {
        __eciMap: map,
        __eciVans: vans,
        __eciPalms: palms,
      });
    const state: Live = {
      map,
      vans,
      palms,
      palmKey: "",
      labels: new Map(),
      labelPx: 0,
      stops: new Map(),
      raf: 0,
      dashStep: 0,
      dashAt: 0,
      loaded: false,
      follow: latest.current.follow,
    };
    live.current = state;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      latest.current.onFail?.();
    };
    const timeout = setTimeout(() => {
      if (!state.loaded) fail();
    }, LOAD_TIMEOUT_MS);
    map.on("error", (e) => {
      // before the style is in, any error means no map (no tiles, no WebGL); after it, a missing tile is fine
      if (!state.loaded) fail();
      else if (/webgl|context/i.test(String(e.error?.message ?? ""))) fail();
    });
    map.on("webglcontextlost", fail);
    // a person moving the map (not the intro or the follow camera: those carry no originalEvent) stops following
    const byHand = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) latest.current.onUserMove?.();
    };
    map.on("dragstart", byHand);
    map.on("zoomstart", byHand);
    map.on("rotatestart", byHand);

    map.once("load", () => {
      state.loaded = true;
      clearTimeout(timeout);
      const d = latest.current.data;
      applyWorld(map, dark);
      const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
      map.addSource("eci-route", { type: "geojson", data: routeGeoJson(d, dark) });
      map.addLayer(
        {
          id: "eci-route-glow",
          type: "line",
          source: "eci-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "colour"],
            "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 14, 14, 18, 22, 20, 44],
            "line-opacity": 0.18,
            "line-blur": 6,
          },
        },
        firstSymbol,
      );
      map.addLayer(
        {
          id: "eci-route",
          type: "line",
          source: "eci-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "colour"],
            "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 14, 4.5, 18, 7, 20, 14],
            "line-opacity": 0.9,
          },
        },
        firstSymbol,
      );
      map.addLayer(
        {
          id: "eci-route-dash",
          type: "line",
          source: "eci-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": dark ? "#f6c982" : "#fbf0dc",
            "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 14, 2.2, 18, 3.5, 20, 7],
            "line-opacity": 0.95,
            "line-dasharray": DASH_SEQUENCE[0],
          },
        },
        firstSymbol,
      );
      map.addSource("eci-stops", { type: "geojson", data: stopsGeoJson(d) });
      map.addLayer(
        {
          id: "eci-stop-pad",
          type: "circle",
          source: "eci-stops",
          paint: {
            "circle-pitch-alignment": "map",
            "circle-pitch-scale": "map",
            "circle-radius": ["interpolate", ["exponential", 1.6], ["zoom"], 13, 5, 16, 14, 20, 90],
            "circle-color": ["case", ["get", "here"], "#e39a2e", dark ? "#5fb0b5" : "#286c71"],
            "circle-opacity": 0.28,
            "circle-stroke-width": 2,
            "circle-stroke-color": ["case", ["get", "here"], "#e39a2e", dark ? "#5fb0b5" : "#286c71"],
            "circle-stroke-opacity": 0.85,
          },
        },
        firstSymbol,
      );
      map.addLayer(palms);
      map.addLayer(vans);
      syncStops(state, d);
      syncPalms(state, d);
      vans.setRoutes(d.routes);
      vans.update(vanFixes(d), performance.now());

      // the intro: a flat, slightly zoomed-out look, then a glide down into the pitched 3D view. It needs the
      // box's real size (a sticky column can measure 0 tall for a frame), so it waits for one if necessary.
      const intro = () => {
        map.resize();
        const b = boundsOf(d);
        const cam = b
          ? map.cameraForBounds(b, { padding: { top: 72, bottom: 56, left: 40, right: 40 }, maxZoom: 16.6 })
          : null;
        const [a, c] = d.spots;
        const heading = a && c ? bearing(a, c) : 0;
        // following (the default): land on the first shuttle, close up; else the whole route
        const van = latest.current.follow ? d.vehicles[0] : undefined;
        const center = van ? ([van.lng, van.lat] as [number, number]) : (cam?.center ?? MANDREM);
        // pitched, the route foreshortens: a touch closer than the flat fit
        const zoom = van ? Math.max(16, (cam?.zoom ?? 14.5) + 0.7) : (cam?.zoom ?? 14.5) + 0.7;
        if (reducedMotion) map.jumpTo({ center, pitch: PITCH, bearing: heading, zoom });
        else {
          map.jumpTo({ center, pitch: 0, bearing: 0, zoom: zoom - 1.2 });
          map.easeTo({
            center,
            pitch: PITCH,
            bearing: heading,
            zoom,
            duration: 2600,
            easing: (t) => 1 - (1 - t) ** 3,
            essential: true,
          });
        }
      };
      if (map.getContainer().clientHeight > 40) intro();
      else {
        const ro = new ResizeObserver(() => {
          if (map.getContainer().clientHeight > 40) {
            ro.disconnect();
            intro();
          }
        });
        ro.observe(map.getContainer());
      }
      // the compact attribution opens itself on load; fold it so the map is the map (the ⓘ stays)
      map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      latest.current.onReady?.();
      startLoop(state, reducedMotion);
    });

    const onVisible = () => {
      if (document.hidden) stopLoop(state);
      else if (state.loaded) startLoop(state, reducedMotion);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(timeout);
      stopLoop(state);
      for (const m of state.labels.values()) m.remove();
      for (const m of state.stops.values()) m.remove();
      live.current = null;
      map.remove();
    };
  }, [dark, reducedMotion]);

  // new positions: vans glide, labels follow, stops / routes are refreshed if they changed
  useEffect(() => {
    const s = live.current;
    if (!s?.loaded) return;
    const src = s.map.getSource("eci-route");
    if (src && "setData" in src)
      (src as { setData: (d: GeoJSON.FeatureCollection) => void }).setData(routeGeoJson(data, dark));
    const pads = s.map.getSource("eci-stops");
    if (pads && "setData" in pads)
      (pads as { setData: (d: GeoJSON.FeatureCollection) => void }).setData(stopsGeoJson(data));
    syncStops(s, data);
    syncPalms(s, data);
    s.vans.setRoutes(data.routes);
    s.vans.update(vanFixes(data), performance.now());
    syncLabels(s, data);
  }, [data, dark]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the first vehicle is read once, when follow flips
  useEffect(() => {
    const s = live.current;
    if (!s) return;
    s.follow = follow;
    const first = data.vehicles[0];
    if (follow && s.loaded && first)
      s.map.easeTo({
        center: [first.lng, first.lat],
        zoom: Math.max(s.map.getZoom(), 16),
        duration: reducedMotion ? 0 : 900,
      });
  }, [follow, reducedMotion]);

  useEffect(() => {
    const s = live.current;
    if (!s) return;
    s.map.resize();
    // full screen: the map owns the gestures; inline on touch: two fingers, so the page still scrolls
    const cg = s.map.cooperativeGestures;
    if (expanded) cg.disable();
    else if (matchMedia("(pointer: coarse)").matches) cg.enable();
  }, [expanded]);

  return <div ref={box} className={className} aria-label={mapAriaLabel(data.vehicles)} role="img" />;
}

function syncStops(s: Live, data: PublicMap) {
  const seen = new Set<string>();
  for (const spot of data.spots) {
    seen.add(spot.id);
    let m = s.stops.get(spot.id);
    if (!m) {
      m = new Marker({ element: stopElement(spot.shortName || spot.name), anchor: "bottom" });
      m.setLngLat([spot.lng, spot.lat]).addTo(s.map);
      s.stops.set(spot.id, m);
    } else m.setLngLat([spot.lng, spot.lat]);
    const here = data.vehicles.some((v) => v.atSpotId === spot.id);
    m.getElement().classList.toggle("is-here", here);
  }
  for (const [id, m] of s.stops)
    if (!seen.has(id)) {
      m.remove();
      s.stops.delete(id);
    }
}

/** Plants the palms for these routes; the same routes keep their trees. */
function syncPalms(s: Live, data: PublicMap) {
  const key = data.routes.map((r) => `${r.id}:${r.path.length}`).join("|");
  if (key === s.palmKey) return;
  s.palmKey = key;
  s.palms.setSites(palmSites(data.routes, data.spots));
}

function syncLabels(s: Live, data: PublicMap) {
  const seen = new Set<string>();
  for (const v of data.vehicles) {
    seen.add(v.id);
    let m = s.labels.get(v.id);
    if (!m) {
      m = new Marker({ element: labelElement(), anchor: "bottom", offset: [0, -s.labelPx] });
      m.setLngLat([v.lng, v.lat]).addTo(s.map);
      s.labels.set(v.id, m);
    }
    const el = m.getElement();
    el.textContent = vanLabelText(v);
    el.classList.toggle("is-break", v.onBreak);
    el.classList.toggle("is-estimated", isEstimated(v));
  }
  for (const [id, m] of s.labels)
    if (!seen.has(id)) {
      m.remove();
      s.labels.delete(id);
    }
}

function startLoop(s: Live, reducedMotion: boolean) {
  if (s.raf) return;
  const tick = (t: number) => {
    s.raf = requestAnimationFrame(tick);
    const moving = s.vans.moving(t);
    if (!reducedMotion && t - s.dashAt > DASH_MS && s.map.getLayer("eci-route-dash")) {
      s.dashAt = t;
      s.dashStep = (s.dashStep + 1) % DASH_SEQUENCE.length;
      s.map.setPaintProperty("eci-route-dash", "line-dasharray", DASH_SEQUENCE[s.dashStep]);
    }
    if (moving) s.map.triggerRepaint();
    // labels follow the rendered vans and sit above the roof whatever the zoom; the camera follows the first
    // one when asked
    const labelPx = vanLabelOffsetPx(vanScreenPx(s.map.getZoom()));
    const lift = labelPx !== s.labelPx;
    s.labelPx = labelPx;
    let first = true;
    for (const [id, m] of s.labels) {
      const p = s.vans.poses.get(id);
      if (!p) continue;
      m.setLngLat([p.lng, p.lat]);
      if (lift) m.setOffset([0, -labelPx]);
      if (first && moving && s.follow) s.map.jumpTo({ center: [p.lng, p.lat] });
      first = false;
    }
  };
  s.raf = requestAnimationFrame(tick);
}

function stopLoop(s: Live) {
  if (s.raf) cancelAnimationFrame(s.raf);
  s.raf = 0;
}
