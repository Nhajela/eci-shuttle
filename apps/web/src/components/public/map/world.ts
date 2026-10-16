/**
 * The look of the world around the shuttle: golden-hour light from the west over the sea, a warm sky and fog at the
 * horizon, the Arabian Sea in the page's teal, sand, greens and whitewash / laterite buildings in place of the
 * tile style's defaults. Light and dark variants of the painted page palette (ink #141b34, teal #286c71, mint
 * #cde1da, marigold #e39a2e). Applied on top of the OpenFreeMap styles (liberty / fiord) once they have loaded;
 * every layer is optional (a style without it is left alone).
 */
import type { ExpressionSpecification, LightSpecification, Map as MlMap, SkySpecification } from "maplibre-gl";

type Paints = Record<string, Record<string, unknown>>;
type PaintKey = Parameters<MlMap["setPaintProperty"]>[1];
type PaintValue = Parameters<MlMap["setPaintProperty"]>[2];
type World = { paints: Paints; sky: SkySpecification; light: LightSpecification };

const HEIGHT: ExpressionSpecification = ["coalesce", ["get", "render_height"], 6];

/** building colour by height: low whitewash villas, taller blocks warm laterite / stone */
const buildingColour = (low: string, mid: string, high: string): ExpressionSpecification => [
  "interpolate",
  ["linear"],
  HEIGHT,
  0,
  low,
  10,
  mid,
  28,
  high,
];

export const LIGHT: World = {
  paints: {
    background: { "background-color": "#f5efe4" },
    water: { "fill-color": "#86c6cb" },
    landcover_sand: { "fill-color": "#f6e7bf" },
    landcover_wood: { "fill-color": "#b4d2a3", "fill-opacity": 0.55 },
    landcover_grass: { "fill-color": "#c8ddb0", "fill-opacity": 0.45 },
    park: { "fill-color": "#cfe2bc", "fill-opacity": 0.75, "fill-outline-color": "rgba(130, 170, 110, 0.6)" },
    landuse_residential: { "fill-color": "rgba(236, 224, 205, 0.45)" },
    road_minor: { "line-color": "#fffaf1" },
    road_minor_casing: { "line-color": "#e3d7c1" },
    road_service_track: { "line-color": "#fff8ec" },
    road_service_track_casing: { "line-color": "#e6dbc7" },
    road_secondary_tertiary: { "line-color": "#fbe6b4" },
    road_secondary_tertiary_casing: { "line-color": "#dfb16c" },
    road_trunk_primary: { "line-color": "#f9dc9a" },
    road_trunk_primary_casing: { "line-color": "#d9a65f" },
    road_path_pedestrian: { "line-color": "#fffdf7" },
    building: { "fill-color": "#f3ead9", "fill-outline-color": "rgba(170, 140, 110, 0.5)" },
    "building-3d": {
      "fill-extrusion-color": buildingColour("#faf5ea", "#f0dcc0", "#dcb08a"),
      "fill-extrusion-height": HEIGHT,
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.92,
      "fill-extrusion-vertical-gradient": true,
    },
  },
  sky: {
    "sky-color": "#8fcbe9",
    "horizon-color": "#f8d8a6",
    "fog-color": "#f6e6cb",
    "fog-ground-blend": 0.6,
    "horizon-fog-blend": 0.65,
    "sky-horizon-blend": 0.7,
    "atmosphere-blend": 0,
  },
  // golden hour: a lowish sun in the west, over the sea (polar 48° from overhead), warm but not orange
  light: { anchor: "map", position: [1.15, 250, 48], color: "#fff1dc", intensity: 0.3 },
};

export const DARK: World = {
  paints: {
    background: { "background-color": "#1a2238" },
    water: { "fill-color": "#17343f" },
    landcover_wood: { "fill-color": "#1f3543", "fill-opacity": 0.8 },
    park: { "fill-color": "#223a45", "fill-opacity": 0.5 },
    landuse_residential: { "fill-color": "rgba(60, 70, 100, 0.35)" },
    highway_minor: { "line-color": "#3a4664" },
    highway_path: { "line-color": "#334059" },
    highway_major_inner: { "line-color": "#4b5679" },
    highway_major_casing: { "line-color": "#2b3450" },
    highway_major_subtle: { "line-color": "#3d4863" },
    building: { "fill-color": "#2a3453", "fill-opacity": 0.5 },
    "building-3d": {
      "fill-extrusion-color": buildingColour("#414d72", "#4f5e92", "#6273ae"),
      "fill-extrusion-height": HEIGHT,
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.92,
      "fill-extrusion-vertical-gradient": true,
    },
  },
  sky: {
    "sky-color": "#0d1428",
    "horizon-color": "#3a4b7c",
    "fog-color": "#1c2541",
    "fog-ground-blend": 0.62,
    "horizon-fog-blend": 0.6,
    "sky-horizon-blend": 0.75,
    "atmosphere-blend": 0,
  },
  // moonlit: a cool low light from the sea, a little warmth kept from the shore lights
  light: { anchor: "map", position: [1.15, 250, 50], color: "#dde4ff", intensity: 0.25 },
};

/** Repaints the loaded style into the page's world. Adds the 3D buildings if the style has none. */
export function applyWorld(map: MlMap, dark: boolean) {
  const world = dark ? DARK : LIGHT;
  if (!map.getLayer("building-3d") && map.getSource("openmaptiles")) {
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addLayer(
      { id: "building-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 14 },
      firstSymbol,
    );
  }
  for (const [layer, paint] of Object.entries(world.paints)) {
    if (!map.getLayer(layer)) continue;
    for (const [k, v] of Object.entries(paint)) map.setPaintProperty(layer, k as PaintKey, v as PaintValue);
  }
  map.setSky(world.sky);
  map.setLight(world.light);
}
