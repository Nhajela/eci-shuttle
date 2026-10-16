/**
 * The 3D shuttles on the public map: a low-poly Indian high-roof minibus (Traveller style: tall white van, big
 * windscreen, sliding door, a marigold garland on the grille, a dash of truck-art colour) built procedurally in
 * three.js and drawn through a MapLibre custom layer. One shared geometry set; a van is a group of meshes.
 * Heading-aware, wheels spin while it glides, a gentle bob. Browser only; loaded lazily with the map.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { MercatorCoordinate } from "maplibre-gl";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { type Pose, type RoutePath, retarget, routePath, sample, type Track } from "./motion";

const VAN_LENGTH_M = 5.6;
/** how long the van should look on screen, in CSS px, whatever the zoom (never smaller than life size) */
const VAN_PX = 66;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;

const WHITE = 0xf4f3ee;
const GLASS = 0x1c3340;
const TYRE = 0x23262e;
const HUB = 0xb9bcc6;
const TEAL = 0x286c71;
const MARIGOLD = 0xe39a2e;
const BLUE = 0x4d65ff;
const LEAF = 0x3c8a4f;

type Parts = {
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  build: (colour: string | null) => { group: THREE.Group; wheels: THREE.Mesh[] };
};

let parts: Parts | null = null;

function lambert(color: number, opts: Partial<THREE.MeshLambertMaterialParameters> = {}) {
  return new THREE.MeshLambertMaterial({ color, ...opts });
}

/** Model units are metres: nose towards -z, y up, origin on the ground under the middle of the van. */
function buildParts(): Parts {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const g = <T extends THREE.BufferGeometry>(x: T) => {
    geometries.push(x);
    return x;
  };
  const m = <T extends THREE.Material>(x: T) => {
    materials.push(x);
    return x;
  };

  const body = g(new RoundedBoxGeometry(2.0, 1.55, 4.6, 3, 0.18));
  const roof = g(new RoundedBoxGeometry(1.86, 0.62, 3.9, 3, 0.22));
  const bonnet = g(new RoundedBoxGeometry(1.9, 0.72, 0.9, 2, 0.14));
  const windscreen = g(new THREE.BoxGeometry(1.7, 0.78, 0.06));
  const sideWindow = g(new THREE.BoxGeometry(0.05, 0.5, 0.95));
  const rearWindow = g(new THREE.BoxGeometry(1.5, 0.5, 0.05));
  const doorLine = g(new THREE.BoxGeometry(0.03, 1.2, 0.04));
  const stripe = g(new THREE.BoxGeometry(0.03, 0.16, 4.3));
  const thinStripe = g(new THREE.BoxGeometry(0.03, 0.06, 4.3));
  const wheel = g(new THREE.CylinderGeometry(0.37, 0.37, 0.26, 14));
  const hub = g(new THREE.CylinderGeometry(0.16, 0.16, 0.28, 10));
  const bead = g(new THREE.SphereGeometry(0.075, 8, 6));
  const leaf = g(new THREE.SphereGeometry(0.05, 6, 4));
  const lamp = g(new THREE.BoxGeometry(0.34, 0.2, 0.06));
  const bumper = g(new THREE.BoxGeometry(1.95, 0.16, 0.12));
  const mirror = g(new THREE.BoxGeometry(0.08, 0.18, 0.12));
  const shadow = g(new THREE.CircleGeometry(1, 20));
  shadow.scale(1.45, 3.2, 1);

  const white = m(lambert(WHITE));
  const glass = m(lambert(GLASS));
  const tyre = m(lambert(TYRE));
  const hubM = m(lambert(HUB));
  const teal = m(lambert(TEAL));
  const marigold = m(lambert(MARIGOLD));
  const blue = m(lambert(BLUE));
  const leafM = m(lambert(LEAF));
  const lampM = m(new THREE.MeshBasicMaterial({ color: 0xfff1b8 }));
  const shadowM = m(
    new THREE.MeshBasicMaterial({ color: 0x141b34, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  const accent = new Map<string, THREE.Material>();

  const build = (colour: string | null) => {
    let stripeM: THREE.Material = teal;
    if (colour) {
      stripeM = accent.get(colour) ?? m(lambert(new THREE.Color(colour).getHex()));
      accent.set(colour, stripeM);
    }
    const group = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      group.add(mesh);
      return mesh;
    };
    const ground = add(shadow, shadowM, 0, 0.02, 0.1);
    ground.rotation.x = -Math.PI / 2;

    add(body, white, 0, 0.42 + 0.775, 0.25);
    add(roof, white, 0, 0.42 + 1.55 + 0.2, 0.55);
    add(bonnet, white, 0, 0.42 + 0.36, -2.65);
    const ws = add(windscreen, glass, 0, 0.42 + 1.2, -2.25);
    ws.rotation.x = -0.32;
    for (const side of [-1, 1]) {
      for (const z of [-1.0, 0.1, 1.2]) add(sideWindow, glass, side * 1.0, 0.42 + 1.1, z);
      add(doorLine, glass, side * 1.01, 0.42 + 0.6, -0.45);
      add(stripe, stripeM, side * 1.01, 0.42 + 0.5, 0.25);
      add(thinStripe, marigold, side * 1.01, 0.42 + 0.64, 0.25);
      add(thinStripe, blue, side * 1.01, 0.42 + 0.36, 0.25);
      const mr = add(mirror, glass, side * 1.08, 0.42 + 1.0, -2.1);
      mr.rotation.y = side * 0.3;
    }
    add(rearWindow, glass, 0, 0.42 + 1.1, 2.56);
    add(bumper, tyre, 0, 0.3, -3.12);
    add(bumper, tyre, 0, 0.3, 2.56);
    add(lamp, lampM, -0.65, 0.42 + 0.5, -3.12);
    add(lamp, lampM, 0.65, 0.42 + 0.5, -3.12);
    // the garland: a shallow U of marigold beads across the grille, with a couple of leaves
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const x = -0.75 + 1.5 * t;
      const y = 0.42 + 0.78 - Math.sin(t * Math.PI) * 0.22;
      add(bead, marigold, x, y, -3.13);
      if (i % 4 === 2) add(leaf, leafM, x + 0.05, y - 0.08, -3.1);
    }
    const wheels: THREE.Mesh[] = [];
    for (const side of [-1, 1])
      for (const z of [-1.7, 1.55]) {
        const w = add(wheel, tyre, side * 0.9, 0.37, z);
        w.rotation.z = Math.PI / 2;
        const h = add(hub, hubM, side * 0.9, 0.37, z);
        h.rotation.z = Math.PI / 2;
        wheels.push(w, h);
      }
    return { group, wheels };
  };

  return { geometries, materials, build };
}

type Van = {
  /** one scene per van: its model matrix is folded into the camera on the CPU (see render) */
  scene: THREE.Scene;
  group: THREE.Group;
  wheels: THREE.Mesh[];
  track: Track;
  /** metres per second it is gliding at, for wheel spin */
  speed: number;
};

/** Lights live in model space (y up, nose on -z): a warm sun from the south-east, a cool fill, sky from above. */
function lit(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xfff6e6, 0x6b7f8c, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(4, 8, 5);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xcfe6ff, 0.8);
  fill.position.set(-5, 4, -4);
  scene.add(fill);
}

export type VanFix = {
  id: string;
  lat: number;
  lng: number;
  headingDeg: number | null;
  colour: string | null;
  /** its route and metres along it: the van then glides along the road (motion.retarget) */
  routeId?: string;
  alongM?: number | null;
};

/** The vans layer: feed it fixes with `update()`; it glides each van there over `glideMs`. */
export class VanLayer implements CustomLayerInterface {
  readonly id = "eci-vans";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map: MlMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private camera = new THREE.Camera();
  private vans = new Map<string, Van>();
  private pending: VanFix[] | null = null;
  private pendingAt = 0;
  private glideMs = 4000;
  /** measured route paths by route id; the same object while the path is unchanged (a glide continues on it) */
  private routes = new Map<string, { key: string; path: RoutePath }>();
  /** last rendered pose per van, for whoever follows it */
  readonly poses = new Map<string, Pose>();
  animate = true;
  /** diagnostics (dev tooling reads these) */
  renders = 0;
  private canvasW = 0;
  private canvasH = 0;

  constructor(opts: { glideMs?: number; animate?: boolean } = {}) {
    this.glideMs = opts.glideMs ?? 4000;
    this.animate = opts.animate ?? true;
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    parts ??= buildParts();
    if (this.pending) this.apply(this.pending, this.pendingAt);
  }

  onRemove() {
    this.vans.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  /** The routes the vans run on (call before `update`); an unchanged path keeps its measured object. */
  setRoutes(routes: { id: string; path: { lat: number; lng: number }[] }[]) {
    const next = new Map<string, { key: string; path: RoutePath }>();
    for (const r of routes) {
      if (r.path.length < 2) continue;
      const a = r.path[0];
      const b = r.path[r.path.length - 1];
      const key = `${r.path.length}:${a?.lat},${a?.lng}:${b?.lat},${b?.lng}`;
      const old = this.routes.get(r.id);
      next.set(r.id, old && old.key === key ? old : { key, path: routePath(r.path) });
    }
    this.routes = next;
  }

  /** New fixes at `nowMs`: vans not in the list leave; the rest glide to their fix (along the road when on it). */
  update(fixes: VanFix[], nowMs: number) {
    if (!parts || !this.map) {
      this.pending = fixes;
      this.pendingAt = nowMs;
      return;
    }
    this.apply(fixes, nowMs);
  }

  private apply(fixes: VanFix[], nowMs: number) {
    if (!parts) return;
    const keep = new Set<string>();
    for (const f of fixes) {
      keep.add(f.id);
      const path = f.routeId ? this.routes.get(f.routeId)?.path : undefined;
      let van = this.vans.get(f.id);
      if (!van) {
        const { group, wheels } = parts.build(f.colour);
        const scene = new THREE.Scene();
        lit(scene);
        scene.add(group);
        van = { scene, group, wheels, track: retarget(undefined, f, nowMs, 0, path), speed: 0 };
        this.vans.set(f.id, van);
      } else {
        const from = sample(van.track, nowMs);
        van.track = retarget(van.track, f, nowMs, this.animate ? this.glideMs : 0, path);
        const road = van.track.road;
        const dLat = (f.lat - from.lat) * 111_320;
        const dLng = (f.lng - from.lng) * 111_320 * Math.cos((f.lat * Math.PI) / 180);
        const distM = road ? Math.abs(road.toM - road.fromM) : Math.hypot(dLat, dLng);
        van.speed = distM / Math.max(1, this.glideMs / 1000);
      }
    }
    for (const [id, van] of this.vans)
      if (!keep.has(id)) {
        van.scene.remove(van.group);
        this.vans.delete(id);
        this.poses.delete(id);
      }
    this.map?.triggerRepaint();
  }

  get count() {
    return this.vans.size;
  }

  /** True while any van is still gliding (the caller keeps repainting). */
  moving(nowMs: number): boolean {
    for (const v of this.vans.values()) if (nowMs < v.track.startMs + v.track.durationMs) return true;
    return false;
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.renderer || !this.map || this.vans.size === 0) return;
    this.renders++;
    const canvas = this.map.getCanvas();
    if (canvas.width !== this.canvasW || canvas.height !== this.canvasH) {
      this.canvasW = canvas.width;
      this.canvasH = canvas.height;
      this.renderer.setSize(canvas.width, canvas.height, false);
    }
    const nowMs = performance.now();
    const zoom = this.map.getZoom();
    // 64-bit on the CPU: mercator coordinates (~0.7) plus a van a few 1e-7 wide would crumble in float32 if the
    // GPU did model × view; so the whole model matrix is folded into the projection here, per van
    const mvp = new THREE.Matrix4().fromArray(
      Array.from(args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix),
    );
    this.renderer.resetState();
    for (const [id, van] of this.vans) {
      const pose = sample(van.track, nowMs);
      this.poses.set(id, pose);
      const mc = MercatorCoordinate.fromLngLat([pose.lng, pose.lat], 0);
      const unit = mc.meterInMercatorCoordinateUnits();
      const metersPerPx = (Math.cos((pose.lat * Math.PI) / 180) * EARTH_CIRCUMFERENCE_M) / (512 * 2 ** zoom);
      const scale = Math.max(1, (VAN_PX * metersPerPx) / VAN_LENGTH_M) * unit;
      const gliding = nowMs < van.track.startMs + van.track.durationMs;
      const bob = this.animate && gliding ? Math.sin(nowMs / 260) * 0.05 : 0;
      // model: x east, y up, z south (after the X rotation); nose on -z = north at heading 0
      const model = new THREE.Matrix4()
        .makeTranslation(mc.x, mc.y, mc.z + bob * scale)
        .scale(new THREE.Vector3(scale, -scale, scale))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      van.group.rotation.y = (-pose.headingDeg * Math.PI) / 180;
      if (this.animate && gliding) {
        const spin = (van.speed / 0.37) * 0.016;
        for (const w of van.wheels) w.rotation.x -= spin;
      }
      this.camera.projectionMatrix.copy(mvp).multiply(model);
      this.renderer.render(van.scene, this.camera);
    }
  }
}
