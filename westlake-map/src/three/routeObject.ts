// The drawn route: three stacked ribbons, a climbable ladder wherever it
// changes floor, and the two end markers.
//
// Why a mitred ribbon and not a TubeGeometry: the overview is the primary
// view, and from above a tube reads as a wet noodle. A flat ribbon lying on
// the plan reads as a lane you could walk down.
//
// Why three ribbons: on white paper, additive bloom does nothing — the
// background is already clamped. The perceptual equivalent of a glow against
// paper is a wide, very low-opacity tinted halo, which costs one draw call
// instead of a post-processing stack.

import * as THREE from "three";
import type { Route3D } from "./routeLift";
import { DASH, RIBBON, type Materials, type RibbonLayer } from "./theme";

const UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);

/**
 * A ribbon of constant width along a 3D polyline, mitred at the joins, with a
 * per-vertex `aDist` (feet travelled) that drives the chase dashes.
 *
 * `lift` raises the ribbon along its own normal so the three layers stack
 * without z-fighting.
 */
function ribbonGeometry(
  points: Float32Array,
  cumulative: Float32Array,
  width: number,
  lift: number
): THREE.BufferGeometry {
  const n = cumulative.length;
  const half = width / 2;

  const left = new Float32Array(n * 3);
  const right = new Float32Array(n * 3);

  const p = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const next = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const side = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    p.fromArray(points, i * 3);
    // Tangent from the neighbours, so joins are mitred rather than faceted.
    if (i > 0) prev.fromArray(points, (i - 1) * 3);
    else prev.copy(p);
    if (i < n - 1) next.fromArray(points, (i + 1) * 3);
    else next.copy(p);
    tan.subVectors(next, prev);
    if (tan.lengthSq() < 1e-9) tan.set(1, 0, 0);
    tan.normalize();

    // side = tangent x up, except on the vertical risers where that degenerates.
    side.crossVectors(tan, UP);
    if (side.lengthSq() < 0.01) side.crossVectors(tan, FALLBACK_UP);
    side.normalize();
    normal.crossVectors(side, tan).normalize();

    // Mitre: widen the join so the outer edge stays parallel through a corner.
    // Clamped, or a hairpin would fire a spike across the building.
    let scale = 1;
    if (i > 0 && i < n - 1) {
      const a = new THREE.Vector3().subVectors(p, prev).normalize();
      const b = new THREE.Vector3().subVectors(next, p).normalize();
      const cosHalf = Math.sqrt(Math.max(0, (1 + a.dot(b)) / 2));
      scale = cosHalf > 0.35 ? 1 / cosHalf : 1 / 0.35;
    }

    const lx = p.x + normal.x * lift;
    const ly = p.y + normal.y * lift;
    const lz = p.z + normal.z * lift;
    const sx = side.x * half * scale;
    const sy = side.y * half * scale;
    const sz = side.z * half * scale;

    left[i * 3] = lx - sx;
    left[i * 3 + 1] = ly - sy;
    left[i * 3 + 2] = lz - sz;
    right[i * 3] = lx + sx;
    right[i * 3 + 1] = ly + sy;
    right[i * 3 + 2] = lz + sz;
  }

  const quads = n - 1;
  const pos = new Float32Array(quads * 6 * 3);
  const dist = new Float32Array(quads * 6);
  let v = 0;
  let d = 0;
  const push = (arr: Float32Array, i: number, dd: number) => {
    pos[v++] = arr[i * 3];
    pos[v++] = arr[i * 3 + 1];
    pos[v++] = arr[i * 3 + 2];
    dist[d++] = dd;
  };
  for (let i = 0; i < quads; i++) {
    const d0 = cumulative[i];
    const d1 = cumulative[i + 1];
    push(left, i, d0);
    push(right, i, d0);
    push(right, i + 1, d1);
    push(left, i, d0);
    push(right, i + 1, d1);
    push(left, i + 1, d1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aDist", new THREE.BufferAttribute(dist, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Chase dashes, driven from `aDist` so they flow continuously across every
 * leg and straight up through a staircase without a seam. Soft dash ends,
 * because a hard edge crawls with aliasing as the camera moves.
 *
 * The uniform object is module-level and the patch is installed once per
 * material, deliberately. three.js caches compiled programs by the material's
 * cache key, so re-running onBeforeCompile with a *new* uniform object after a
 * route rebuild gets you the cached program still holding a reference to the
 * old object — the dashes freeze and never move again. One object, mutated in
 * place, sidesteps that entirely.
 */
const DASH_OFFSET = { value: 0 };
const dashPatched = new WeakSet<THREE.Material>();

function applyDashShader(material: THREE.MeshBasicMaterial): void {
  if (dashPatched.has(material)) return;
  dashPatched.add(material);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDashOffset = DASH_OFFSET;
    shader.vertexShader =
      "attribute float aDist;\nvarying float vDist;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n vDist = aDist;");
    shader.fragmentShader =
      "uniform float uDashOffset;\nvarying float vDist;\n" +
      shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
         float period = ${DASH.period.toFixed(2)};
         float on = ${DASH.on.toFixed(2)};
         float soft = ${DASH.soften.toFixed(2)};
         float t = mod(vDist - uDashOffset, period);
         float a = smoothstep(0.0, soft, t) * (1.0 - smoothstep(on - soft, on, t));
         gl_FragColor.a *= max(a, 0.13);`
      );
  };
  material.customProgramCacheKey = () => "westlake-route-dash";
  material.needsUpdate = true;
}

export interface RouteObject {
  group: THREE.Group;
  /** Advance the dash flow and the destination pulse. */
  update(dtSeconds: number): void;
  dispose(): void;
}

export interface RouteObjectOptions {
  materials: Materials;
  reducedMotion: boolean;
  /** Feet of vertical travel per riser — used to space the ladder rungs. */
  spread: number;
}

/**
 * Build every object that draws the route. The caller owns placement in the
 * scene; everything here is already in world coordinates.
 */
export function buildRouteObject(route: Route3D, opts: RouteObjectOptions): RouteObject {
  const { materials: M, reducedMotion } = opts;
  const group = new THREE.Group();
  group.name = "route";

  const owned: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  // --- the three ribbons -------------------------------------------------
  const layers: Array<[RibbonLayer, THREE.MeshBasicMaterial]> = [
    [RIBBON.halo, M.routeHalo],
    [RIBBON.casing, M.routeCasing],
    [RIBBON.core, M.routeCore],
  ];
  for (const [layer, mat] of layers) {
    const g = track(ribbonGeometry(route.points, route.cumulative, layer.width, layer.lift));
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = layer.order;
    mesh.frustumCulled = false; // one object spanning the whole building
    group.add(mesh);
  }

  if (!reducedMotion) applyDashShader(M.routeCore);

  // --- staircase ladders -------------------------------------------------
  // The route crosses tens of feet of open air at every floor change. A bare
  // line reads as a glitch; rungs read unambiguously as stairs and make the
  // vertical distance countable.
  const RUNGS = 7;
  const rungGeom = track(new THREE.BoxGeometry(4.0, 0.5, 0.4));
  const coneGeom = track(new THREE.ConeGeometry(3.4, 6, 6));
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (const riser of route.risers) {
    a.fromArray(route.points, riser.startIndex * 3);
    b.fromArray(route.points, riser.endIndex * 3);
    const rungs = new THREE.InstancedMesh(rungGeom, M.markerAccentFlat, RUNGS);
    const m = new THREE.Matrix4();
    for (let i = 0; i < RUNGS; i++) {
      const t = (i + 0.5) / RUNGS;
      m.makeTranslation(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.z + (b.z - a.z) * t
      );
      rungs.setMatrixAt(i, m);
    }
    rungs.instanceMatrix.needsUpdate = true;
    rungs.renderOrder = 4;
    owned.push(rungs); // an InstancedMesh owns its instanceMatrix buffer
    group.add(rungs);

    // A chevron at the top, pointing the way the route is travelling.
    const cone = new THREE.Mesh(coneGeom, M.markerAccentFlat);
    cone.position.set(b.x, b.y + 3, b.z);
    if (b.y < a.y) cone.rotation.x = Math.PI; // going down
    cone.renderOrder = 4;
    group.add(cone);
  }

  // --- start marker ------------------------------------------------------
  const start = new THREE.Vector3().fromArray(route.points, 0);
  const haloGeom = track(new THREE.CircleGeometry(10, 40));
  const startHalo = new THREE.Mesh(haloGeom, M.markerMaroonSoft);
  startHalo.rotation.x = -Math.PI / 2;
  startHalo.position.set(start.x, start.y - 2.1, start.z);
  startHalo.renderOrder = 1;
  group.add(startHalo);

  const discGeom = track(new THREE.CircleGeometry(4.5, 32));
  const startDisc = new THREE.Mesh(discGeom, M.markerMaroon);
  startDisc.rotation.x = -Math.PI / 2;
  startDisc.position.set(start.x, start.y - 1.6, start.z);
  startDisc.renderOrder = 5;
  group.add(startDisc);

  // An open cylinder gives the disc a lip, so it reads three-dimensionally
  // instead of as a sticker.
  const lipGeom = track(new THREE.CylinderGeometry(4.5, 4.5, 1.5, 32, 1, true));
  const lip = new THREE.Mesh(lipGeom, M.markerMaroon);
  lip.position.set(start.x, start.y - 2.35, start.z);
  group.add(lip);

  // --- destination marker ------------------------------------------------
  const endIdx = route.cumulative.length - 1;
  const end = new THREE.Vector3().fromArray(route.points, endIdx * 3);
  const spikeGeom = track(new THREE.ConeGeometry(2.2, 14, 6));
  const spike = new THREE.Mesh(spikeGeom, M.markerAccent);
  spike.rotation.x = Math.PI; // apex down, touching the floor
  spike.position.set(end.x, end.y + 5.0, end.z);
  group.add(spike);

  const ballGeom = track(new THREE.SphereGeometry(3.2, 20, 14));
  const ball = new THREE.Mesh(ballGeom, M.markerAccent);
  ball.position.set(end.x, end.y + 13.5, end.z);
  group.add(ball);

  // The pulse is the only looping animation besides the dashes: it is the
  // "you are going here" cue, and it should be the brightest moving thing.
  const pulseGeom = track(new THREE.RingGeometry(0.86, 1.0, 48));
  const pulse = new THREE.Mesh(pulseGeom, M.pulse.clone());
  const pulseMat = pulse.material as THREE.MeshBasicMaterial;
  owned.push(pulseMat);
  pulse.rotation.x = -Math.PI / 2;
  pulse.position.set(end.x, end.y - 2.0, end.z);
  pulse.renderOrder = 2;
  pulse.visible = !reducedMotion;
  group.add(pulse);

  let pulseT = 0;

  return {
    group,
    update(dt: number) {
      if (reducedMotion) return;
      DASH_OFFSET.value += DASH.speed * dt;
      // 1.6s expand, 0.4s hold
      pulseT = (pulseT + dt) % 2.0;
      const t = Math.min(1, pulseT / 1.6);
      const eased = 1 - (1 - t) * (1 - t);
      const r = 6 + (14 - 6) * eased;
      pulse.scale.setScalar(r);
      pulseMat.opacity = 0.35 * (1 - eased);
    },
    dispose() {
      for (const o of owned) o.dispose();
      group.clear();
    },
  };
}
