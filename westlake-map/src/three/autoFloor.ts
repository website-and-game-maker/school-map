// Which floor is the map looking at?
//
// The floor selector picks itself. A route already moves it (each leg is on a
// floor), and this is the other half: pan or zoom the map onto part of the
// school and the floor that is actually *there* becomes the one you are
// reading, the way an indoor map switches to the building you zoom into.
//
// "Actually there" is measured on the building itself, not on its labels.
// The view is sampled on a grid, every sample is dropped onto the ground, and
// each floor scores the share of those samples that land inside its
// footprint, weighted toward the middle of the screen. That is the question a
// person is asking: "how much of what I'm looking at is this floor?"
//
// It used to count labels (rooms, entrances, places) inside a small circle
// around the middle of the view and needed one floor to have twice as many as
// the other. That almost never fired: Main has a numbered room nearly
// everywhere, so it out-counted Lower even with Lower's South Complex filling
// the screen and Main showing nothing but car park.
//
// The storeys overlap over much of the building, so where two floors cover
// about the same share of the view nothing says which one you mean, and the
// floor you are on stays put. Without that dead band, panning across the
// middle of the school would flick between floors under your finger.

import type { FloorId } from "../types";

/** One floor's footprint as closed rings in world X/Z (feet), even-odd fill. */
export interface FloorShape {
  rings: Float32Array[];
  /** Bounding box of all rings: minX, minZ, maxX, maxZ. */
  box: [number, number, number, number];
}

export type FloorShapes = Record<FloorId, FloorShape>;

/** A sampled ground point and how much it counts (the middle counts more). */
export interface Sample {
  x: number;
  z: number;
  w: number;
}

/** How much more of the view another floor must cover before it takes over. */
const TAKEOVER = 1.4;
/** …and by at least this much of the view, absolutely. */
const MARGIN = 0.12;
/** A floor has to cover at least this share of the view to be picked at all. */
const ENOUGH = 0.2;

export function makeShape(rings: number[][]): FloorShape {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const out: Float32Array[] = [];
  for (const r of rings) {
    if (r.length < 6) continue;
    const a = new Float32Array(r);
    for (let i = 0; i < a.length; i += 2) {
      if (a[i] < minX) minX = a[i];
      if (a[i] > maxX) maxX = a[i];
      if (a[i + 1] < minZ) minZ = a[i + 1];
      if (a[i + 1] > maxZ) maxZ = a[i + 1];
    }
    out.push(a);
  }
  return { rings: out, box: [minX, minZ, maxX, maxZ] };
}

/** Even-odd point-in-polygon over every ring, so holes stay holes. */
export function inside(shape: FloorShape, x: number, z: number): boolean {
  const [x0, z0, x1, z1] = shape.box;
  if (x < x0 || x > x1 || z < z0 || z > z1) return false;
  let hit = false;
  for (const r of shape.rings) {
    const n = r.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
  }
  return hit;
}

/** Each floor's weighted share (0..1) of the samples that land on it. */
export function coverage(
  shapes: FloorShapes,
  order: readonly FloorId[],
  samples: readonly Sample[]
): Record<FloorId, number> {
  const out = {} as Record<FloorId, number>;
  let total = 0;
  for (const s of samples) total += s.w;
  for (const f of order) {
    let n = 0;
    for (const s of samples) if (inside(shapes[f], s.x, s.z)) n += s.w;
    out[f] = total > 0 ? n / total : 0;
  }
  return out;
}

/**
 * The floor to show, given how much of the view each floor covers. Returns
 * `current` when the answer is unclear.
 */
export function pickFloor(
  cover: Record<FloorId, number>,
  order: readonly FloorId[],
  current: FloorId
): FloorId {
  let best = current;
  for (const f of order) {
    if (cover[f] > cover[best]) best = f;
    // Ties go to whichever is nearer the floor you are on: one flight, not two.
    else if (cover[f] === cover[best] && f !== best && dist(order, f, current) < dist(order, best, current)) best = f;
  }
  if (best === current) return current;
  const mine = cover[current];
  if (cover[best] < ENOUGH) return current;
  if (cover[best] < Math.max(mine * TAKEOVER, mine + MARGIN)) return current;
  return best;
}

function dist(order: readonly FloorId[], a: FloorId, b: FloorId): number {
  return Math.abs(order.indexOf(a) - order.indexOf(b));
}
