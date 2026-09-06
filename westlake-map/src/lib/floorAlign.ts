// The three plans are separate scans at different scales, so a point on one
// floor has no direct meaning on another. The entrances are the one feature
// traced on multiple floors at a real physical location, so they anchor a
// similarity transform between floor coordinate frames.
//
// It's approximate — a handful of hand-placed points — which is why it's used
// only to decide whether two stair markers on different floors are the *same*
// stairwell, a question with tens of feet of slack in it.

import type { FloorData, FloorId } from "../types";

export interface Transform {
  scale: number;
  rot: [number, number, number, number]; // 2x2, row-major
  from: [number, number];
  to: [number, number];
}

function sharedEntrances(a: FloorData, b: FloorData): [string, [number, number], [number, number]][] {
  const nameOf = (f: FloorData) => {
    const m = new Map<string, [number, number]>();
    for (const [id, p] of Object.entries(f.points)) {
      if (p.kind === "entrance") m.set(p.label ?? id, [p.x, p.y]);
    }
    return m;
  };
  const A = nameOf(a);
  const B = nameOf(b);
  const out: [string, [number, number], [number, number]][] = [];
  for (const [name, pa] of A) {
    const pb = B.get(name);
    if (pb) out.push([name, pa, pb]);
  }
  return out;
}

/** Least-squares similarity transform taking `from` coords to `to` coords. */
export function fitTransform(from: FloorData, to: FloorData): Transform | null {
  const pairs = sharedEntrances(from, to);
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const meanA: [number, number] = [0, 0];
  const meanB: [number, number] = [0, 0];
  for (const [, a, b] of pairs) {
    meanA[0] += a[0] / n;
    meanA[1] += a[1] / n;
    meanB[0] += b[0] / n;
    meanB[1] += b[1] / n;
  }
  let sxx = 0, sxy = 0, syx = 0, syy = 0, normA = 0;
  for (const [, a, b] of pairs) {
    const ax = a[0] - meanA[0], ay = a[1] - meanA[1];
    const bx = b[0] - meanB[0], by = b[1] - meanB[1];
    sxx += ax * bx;
    sxy += ax * by;
    syx += ay * bx;
    syy += ay * by;
    normA += ax * ax + ay * ay;
  }
  if (normA < 1e-6) return null;
  // best rotation for a 2D similarity fit reduces to one angle
  const theta = Math.atan2(sxy - syx, sxx + syy);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const scale = (cos * (sxx + syy) + sin * (sxy - syx)) / normA;
  return {
    scale,
    rot: [cos, -sin, sin, cos],
    from: meanA,
    to: meanB,
  };
}

export function applyTransform(t: Transform, x: number, y: number): [number, number] {
  const dx = x - t.from[0];
  const dy = y - t.from[1];
  return [
    t.scale * (t.rot[0] * dx + t.rot[1] * dy) + t.to[0],
    t.scale * (t.rot[2] * dx + t.rot[3] * dy) + t.to[1],
  ];
}

export function buildTransforms(
  floors: Record<FloorId, FloorData>
): Partial<Record<string, Transform>> {
  const out: Partial<Record<string, Transform>> = {};
  const ids: FloorId[] = ["lower", "main", "upper"];
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const t = fitTransform(floors[a], floors[b]);
      if (t) out[`${a}->${b}`] = t;
    }
  }
  return out;
}
