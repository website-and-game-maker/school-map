// The floor plate for each storey: the building's footprint, triangulated, with
// UVs that land the plan scan on it exactly.
//
// This is the idea the whole 3D view rests on. The scan is not a decoration —
// it is the map, and it carries all 216 room numbers. Using it as the floor
// texture means the walls rise out of the real drawing and the numbers stay
// readable from above, so nothing has to be re-labelled in 3D.

import * as THREE from "three";
import type { FloorId } from "../types";
import { planToWorld, type FloorPlacement } from "./placement";
import { SLAB_THICKNESS } from "./units";
import { wallsFile } from "./walls";

/** A storey can be several detached wings on these drawings (main has 9), so
 *  every part is rendered — footprint[0] is not the whole floor. */
export function buildSlabGeometry(
  floor: FloorId,
  p: FloorPlacement
): { top: THREE.BufferGeometry; skirt: THREE.BufferGeometry } {
  const f = wallsFile(floor);

  const topPos: number[] = [];
  const topUv: number[] = [];
  const topNrm: number[] = [];
  const skirtPos: number[] = [];
  const skirtNrm: number[] = [];

  const toVec2 = (flat: number[]) => {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < flat.length; i += 2) out.push(new THREE.Vector2(flat[i], flat[i + 1]));
    return out;
  };

  for (const part of f.footprint) {
    const contour = toVec2(part.outer);
    const holes = (part.holes ?? []).map(toVec2);
    if (contour.length < 3) continue;

    let faces: number[][] = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    } catch {
      continue; // a degenerate ring is not worth taking the whole floor down for
    }
    const all = contour.concat(...holes);

    for (const tri of faces) {
      const vs = tri.map((idx) => all[idx]);
      if (vs.some((v) => !v)) continue;
      // Wind every triangle so its front face points up. The tracer's rings are
      // clockwise on the page, and plan +y maps to world +Z, so the natural
      // order comes out facing DOWN — which under a single-sided material hides
      // the plan scan entirely, and under a double-sided one flips the shading
      // normal so the floor is lit from underneath.
      const [a, b, c] = vs;
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const ordered = cross > 0 ? [a, c, b] : [a, b, c];
      for (const v of ordered) {
        const w = planToWorld(p, v.x, v.y, 0);
        topPos.push(w[0], 0, w[2]);
        // The scan is sampled in this floor's own plan pixels, so the texture
        // lands on the plate regardless of where placement puts the storey.
        topUv.push(v.x / f.w, 1 - v.y / f.h);
        topNrm.push(0, 1, 0);
      }
    }

    // The slab's visible edge. Hanging it below the plate gives every storey a
    // thickness, which is what stops the exploded stack reading as floating
    // sheets of paper.
    const rings = [contour, ...holes];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const wa = planToWorld(p, a.x, a.y, 0);
        const wb = planToWorld(p, b.x, b.y, 0);
        const ex = wb[0] - wa[0];
        const ez = wb[2] - wa[2];
        const len = Math.hypot(ex, ez) || 1;
        const n: [number, number, number] = [ez / len, 0, -ex / len];
        const t = -SLAB_THICKNESS;
        const quad: Array<[number, number, number]> = [
          [wa[0], 0, wa[2]],
          [wb[0], 0, wb[2]],
          [wb[0], t, wb[2]],
          [wa[0], 0, wa[2]],
          [wb[0], t, wb[2]],
          [wa[0], t, wa[2]],
        ];
        for (const v of quad) {
          skirtPos.push(v[0], v[1], v[2]);
          skirtNrm.push(n[0], n[1], n[2]);
        }
      }
    }
  }

  const top = new THREE.BufferGeometry();
  top.setAttribute("position", new THREE.BufferAttribute(new Float32Array(topPos), 3));
  top.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(topUv), 2));
  top.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(topNrm), 3));
  top.computeBoundingSphere();

  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute("position", new THREE.BufferAttribute(new Float32Array(skirtPos), 3));
  skirt.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(skirtNrm), 3));
  skirt.computeBoundingSphere();

  return { top, skirt };
}
