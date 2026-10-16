/**
 * Low-poly coconut palms along the route (palms.ts says where): one instanced trunk mesh and one instanced crown
 * mesh, so a few hundred trees cost two draw calls. A gentle sway in the sea breeze unless motion is reduced.
 * Drawn through a MapLibre custom layer in a local metric frame around the first tree (the frame's origin is
 * folded into the projection on the CPU, like the vans, so float32 on the GPU is enough). Browser only.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { MercatorCoordinate } from "maplibre-gl";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PalmSite } from "./palms";
import { lit } from "./van-layer";
import { treeScreenScale } from "./van-scale";

const TRUNK = 0x8c6b4b;
const FROND = 0x3f8b4e;
const FROND_LIGHT = 0x6fae58;
const COCONUT = 0x7a5a33;
const FRONDS = 8;
/** radians of sway at the crown, and how fast the breeze goes */
const SWAY = 0.045;
const SWAY_MS = 1700;
/** radians each trunk leans */
const LEAN = 0.07;

type Geometry = { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; materials: THREE.Material[] };

let shared: Geometry | null = null;

/** Metres, y up, base at the origin; the trunk is 1 m tall (scaled per tree), the crown sits at its top. */
function buildGeometry(): Geometry {
  const trunk = new THREE.CylinderGeometry(0.17, 0.3, 1, 6, 1);
  trunk.translate(0, 0.5, 0);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < FRONDS; i++) {
    // a frond: a thin plank that droops from the crown; alternate shades so the crown has depth
    const frond = new THREE.BoxGeometry(0.55, 0.05, 2.7, 1, 1, 3);
    const pos = frond.attributes.position as THREE.BufferAttribute;
    // curl the tip down: a quadratic droop along the length
    for (let v = 0; v < pos.count; v++) {
      const z = pos.getZ(v);
      const t = (z + 1.35) / 2.7;
      pos.setY(v, pos.getY(v) - 0.9 * t * t);
      pos.setX(v, pos.getX(v) * (1 - 0.7 * t));
    }
    frond.translate(0, 0.15, 1.3);
    frond.rotateX(-0.35);
    frond.rotateY((i / FRONDS) * Math.PI * 2 + (i % 2) * 0.2);
    const shade = i % 2 ? FROND_LIGHT : FROND;
    const col = new THREE.Color(shade);
    const n = (frond.attributes.position as THREE.BufferAttribute).count;
    const colours = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) colours.set([col.r, col.g, col.b], v * 3);
    frond.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    parts.push(frond);
  }
  for (const [x, z] of [
    [0.18, 0.1],
    [-0.12, 0.2],
    [0.05, -0.2],
  ] as const) {
    const nut = new THREE.SphereGeometry(0.16, 6, 5);
    nut.translate(x, -0.05, z);
    const col = new THREE.Color(COCONUT);
    const n = (nut.attributes.position as THREE.BufferAttribute).count;
    const colours = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) colours.set([col.r, col.g, col.b], v * 3);
    nut.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    parts.push(nut);
  }
  const crown = mergeGeometries(parts, false) as THREE.BufferGeometry;
  for (const p of parts) p.dispose();
  const materials = [
    new THREE.MeshLambertMaterial({ color: TRUNK }),
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  ];
  return { trunk, crown, materials };
}

export class PalmLayer implements CustomLayerInterface {
  readonly id = "eci-palms";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  animate = true;
  private map: MlMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private camera = new THREE.Camera();
  private scene = new THREE.Scene();
  private trunks: THREE.InstancedMesh | null = null;
  private crowns: THREE.InstancedMesh | null = null;
  /** local frame: metres east / south of `origin` */
  private origin: MercatorCoordinate | null = null;
  private unit = 1;
  private local: { e: number; s: number; h: number; yaw: number; phase: number }[] = [];
  /** the exaggeration the instance matrices were built with (see van-scale.treeScreenScale) */
  private grown = 0;
  private lat = 0;
  private pending: PalmSite[] | null = null;
  private canvasW = 0;
  private canvasH = 0;
  private tmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), v: new THREE.Vector3() };

  constructor(opts: { animate?: boolean; dark?: boolean } = {}) {
    this.animate = opts.animate ?? true;
    lit(this.scene, opts.dark ?? false);
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    shared ??= buildGeometry();
    if (this.pending) this.setSites(this.pending);
  }

  onRemove() {
    this.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  private clear() {
    if (this.trunks) {
      this.scene.remove(this.trunks);
      this.trunks.dispose();
      this.trunks = null;
    }
    if (this.crowns) {
      this.scene.remove(this.crowns);
      this.crowns.dispose();
      this.crowns = null;
    }
    this.local = [];
  }

  get count() {
    return this.local.length;
  }

  /** Plant the trees (replacing any before). */
  setSites(sites: PalmSite[]) {
    if (!shared || !this.map) {
      this.pending = sites;
      return;
    }
    this.pending = null;
    this.clear();
    if (!sites.length) return;
    const first = sites[0] as PalmSite;
    const origin = MercatorCoordinate.fromLngLat([first.lng, first.lat], 0);
    this.origin = origin;
    this.lat = first.lat;
    this.unit = origin.meterInMercatorCoordinateUnits();
    this.local = sites.map((s, i) => {
      const mc = MercatorCoordinate.fromLngLat([s.lng, s.lat], 0);
      return {
        e: (mc.x - origin.x) / this.unit,
        s: (mc.y - origin.y) / this.unit,
        h: s.height,
        yaw: s.yaw,
        phase: (i * 2.399) % (Math.PI * 2),
      };
    });
    const trunks = new THREE.InstancedMesh(shared.trunk, shared.materials[0] as THREE.Material, sites.length);
    const crowns = new THREE.InstancedMesh(shared.crown, shared.materials[1] as THREE.Material, sites.length);
    // instance matrices are tiny next to the folded projection: no culling, we always draw the lot
    trunks.frustumCulled = false;
    crowns.frustumCulled = false;
    this.trunks = trunks;
    this.crowns = crowns;
    this.scene.add(trunks, crowns);
    this.grow(treeScreenScale(this.map.getZoom(), this.lat));
    this.placeCrowns(0);
    this.map.triggerRepaint();
  }

  /** Rebuilds the trunks at this exaggeration (each tree scales about its own base). */
  private grow(scale: number) {
    const trunks = this.trunks;
    if (!trunks) return;
    this.grown = scale;
    const { m, q, e, v } = this.tmp;
    const size = new THREE.Vector3();
    this.local.forEach((t, i) => {
      // a few degrees of lean in a direction of its own, so a grove is not all parallel
      e.set(LEAN * Math.sin(t.phase), t.yaw, LEAN * Math.cos(t.phase));
      q.setFromEuler(e);
      m.compose(v.set(t.e, 0, t.s), q, size.set(scale, t.h * scale, scale));
      trunks.setMatrixAt(i, m);
    });
    trunks.instanceMatrix.needsUpdate = true;
  }

  private placeCrowns(nowMs: number) {
    const crowns = this.crowns;
    if (!crowns) return;
    const { m, q, e, v } = this.tmp;
    const g = this.grown;
    const scale = new THREE.Vector3(g, g, g);
    const top = new THREE.Vector3();
    const breeze = this.animate ? (nowMs / SWAY_MS) * Math.PI * 2 : 0;
    this.local.forEach((t, i) => {
      // the crown sits on the top of the leaning trunk: the trunk's rotation applied to (0, h, 0)
      e.set(LEAN * Math.sin(t.phase), t.yaw, LEAN * Math.cos(t.phase));
      q.setFromEuler(e);
      top.set(0, t.h * g, 0).applyQuaternion(q);
      const sway = this.animate ? SWAY * Math.sin(breeze + t.phase) : 0;
      e.set(LEAN * Math.sin(t.phase) + sway * 0.6, t.yaw, LEAN * Math.cos(t.phase) + sway);
      q.setFromEuler(e);
      m.compose(v.set(t.e + top.x, top.y, t.s + top.z), q, scale);
      crowns.setMatrixAt(i, m);
    });
    crowns.instanceMatrix.needsUpdate = true;
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.renderer || !this.map || !this.origin || !this.local.length) return;
    const canvas = this.map.getCanvas();
    if (canvas.width !== this.canvasW || canvas.height !== this.canvasH) {
      this.canvasW = canvas.width;
      this.canvasH = canvas.height;
      this.renderer.setSize(canvas.width, canvas.height, false);
    }
    const scale = treeScreenScale(this.map.getZoom(), this.lat);
    const regrow = Math.abs(scale - this.grown) > this.grown * 0.01;
    if (regrow) this.grow(scale);
    if (this.animate || regrow) this.placeCrowns(performance.now());
    const mvp = new THREE.Matrix4().fromArray(
      Array.from(args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix),
    );
    const o = this.origin;
    const u = this.unit;
    // model: x east, y up, z south (see van-layer.render)
    const model = new THREE.Matrix4()
      .makeTranslation(o.x, o.y, o.z)
      .scale(new THREE.Vector3(u, -u, u))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    this.camera.projectionMatrix.copy(mvp).multiply(model);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }
}
