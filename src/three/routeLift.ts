// Turning a computed route into a 3D polyline.
//
// This module is pure arithmetic: no three.js, no Object3D, no materials. It
// takes what `router.ts` already produced — a per-floor list of wall-aware
// polylines in each page's own plan pixels — and stitches it into one
// continuous world-space ribbon spine, with the vertical hops between storeys
// made explicit. `routeObject.ts` turns that spine into geometry.
//
// Three things about the input have to be respected, and each of them has bitten
// an earlier attempt:
//
//  1. `router.ts` has ALREADY decimated (line-of-sight `simplify`) and filleted
//     (`roundCorners`) every leg. Do not re-simplify, and above all do not spline
//     this. A Catmull-Rom through these points cuts the very corners the router
//     routed around, which pushes the ribbon through walls. We transform and
//     stitch; we never reshape.
//
//  2. `legs.length - 1` is NOT `stairs.length`. The router solves a small graph
//     over stair landings and happily emits two consecutive legs on the same
//     floor (walk from stairwell X to stairwell Y). Risers are therefore decided
//     from `legs[i].floor !== legs[i+1].floor` and `route.stairs` is walked with
//     its own cursor, used only to recover the `verified` flag.
//
//  3. Route endpoints are the traced room-label positions — `router.ts` prepends
//     `startPoint` and appends `endPoint` verbatim, without snapping them to
//     walkable space. They frequently sit on top of ink. In 2D the line just
//     touches the room number; in 3D it spears a wall. So the lift height ramps
//     up at both ends and the ribbon arcs over the wall into the room.

import type { FloorId } from "../types";
import type { GridRoute } from "../lib/router";
import type { Directions } from "../lib/directions";
import { FLOOR_INDEX, storeyY } from "./units";
import { planToWorld, type PlacementSet } from "./placement";

/** How far the ribbon spine floats above the slab top along a normal run.
 *  High enough that it never z-fights the plan texture and stays visible when
 *  the camera drops near the horizon; low enough to still read as painted on
 *  the floor. `routeObject.ts` stacks its halo/casing/core offsets on top of
 *  this, so this is the one knob if the ribbon ever reads as floating. */
export const ROUTE_LIFT_FT = 2.5;

/** Lift at the very first and very last point. See note 3 above: the endpoint
 *  is an unsnapped label position, so the spine has to clear whatever wall sits
 *  between the corridor and the room label. */
export const ROUTE_ENDPOINT_LIFT_FT = 6.5;

/** Distance over which the endpoint lift decays back to `ROUTE_LIFT_FT`. */
export const ENDPOINT_RAMP_FT = 8;

/** Interior samples per riser, plus the two shared leg endpoints. A straight
 *  vertical jump reads as a glitch; an eased ramp reads as leaving one floor
 *  and arriving at the next. */
export const RISER_SAMPLES = 12;

/** Two points closer than this are the same point. `roundCorners` can emit a
 *  duplicate when a fillet collapses, and a same-floor leg change starts where
 *  the previous one ended — a zero-length segment would produce a NaN tangent. */
const EPS_FT = 1e-4;

/** Restricted step-anchor search this far off its own leg means the leg index
 *  is lying; fall back to searching the whole spine. */
const ANCHOR_FALLBACK_FT = 50;

/** One vertical connection in the lifted route. `startIndex`/`endIndex` bracket
 *  the whole hop including its two floor-level endpoints, so `routeObject.ts`
 *  can give it its own material and the fly camera can slow through it. */
export interface RiserSpan {
  startIndex: number;
  endIndex: number;
  fromFloor: FloorId;
  toFloor: FloorId;
  /** Mirrors the matching `GridRoute.stairs` entry. Every shipped stair link is
   *  currently `false` — the 3D view is expected to draw those differently. */
  verified: boolean;
}

/** The span of `points` contributed by one `GridRoute.legs` entry, in order and
 *  one-for-one with it, so `DirectionStep.legIndex` indexes straight into this. */
export interface LegSpan {
  startIndex: number;
  endIndex: number;
  floor: FloorId;
}

export interface Route3D {
  /** xyz triples in world feet, Y up. */
  points: Float32Array;
  /** Arc length in feet at each point; `cumulative[0] === 0`. */
  cumulative: Float32Array;
  totalFt: number;
  legs: LegSpan[];
  risers: RiserSpan[];
  /** One entry per `Directions.steps`, aligned by index: the point the step
   *  happens at, or null for a step with no position. */
  stepAnchors: (number | null)[];
}

function smoothstep(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** 1 at the endpoint, 0 once `ENDPOINT_RAMP_FT` in. */
function endRamp(distFromEndFt: number): number {
  return smoothstep(1 - distFromEndFt / ENDPOINT_RAMP_FT);
}

/**
 * Stitch a `GridRoute` into one world-space spine.
 *
 * `spread` is the current storey separation in feet — the camera-driven value
 * from `spreadForElevation()`, not a mode flag — so re-lifting on every spread
 * change is how the ribbon follows the plates as the stack opens and collapses.
 */
export function liftRoute(
  route: GridRoute,
  placements: PlacementSet,
  spread: number,
  directions: Directions | null
): Route3D {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  // Riser interiors get their Y recomputed after the endpoint ramp is applied,
  // so the hop always lands exactly on whatever height its two ends ended up at.
  const riserOf: number[] = []; // -1 for a floor-level point, else riser index
  const riserT: number[] = [];

  const push = (x: number, y: number, z: number, riser: number, t: number): number => {
    const n = xs.length;
    if (n > 0) {
      const dx = x - xs[n - 1];
      const dy = y - ys[n - 1];
      const dz = z - zs[n - 1];
      if (dx * dx + dy * dy + dz * dz < EPS_FT * EPS_FT) return n - 1;
    }
    xs.push(x);
    ys.push(y);
    zs.push(z);
    riserOf.push(riser);
    riserT.push(t);
    return n;
  };

  const legs: LegSpan[] = [];
  const risers: RiserSpan[] = [];
  let stairCursor = 0;
  // A riser can only be closed once the landing leg's first point has an index,
  // because `push` deduplicates and may not grow the array.
  let pending: Omit<RiserSpan, "endIndex"> | null = null;

  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    const place = placements[leg.floor];
    const baseY = storeyY(leg.floor, spread) + ROUTE_LIFT_FT;

    // Where this leg starts, in world space. Needed up front because a riser has
    // to be drawn to it before the leg's own points are emitted.
    const [fx, fy, fz] = planToWorld(place, leg.path[0][0], leg.path[0][1], baseY);

    if (i > 0 && route.legs[i - 1].floor !== leg.floor) {
      // A genuine floor change. Consume one `stairs` entry — they are pushed in
      // travel order, so the k-th change is the k-th entry — but trust the leg
      // floors, not the entry's. When they disagree the positional assumption
      // has already broken (a zero-length connecting leg on the middle floor
      // gets filtered out by the router), and claiming "verified" would be a lie.
      const from = route.legs[i - 1].floor;
      const entry = stairCursor < route.stairs.length ? route.stairs[stairCursor++] : null;
      const verified =
        entry != null && entry.from === from && entry.to === leg.floor ? entry.verified : false;

      const aIndex = xs.length - 1;
      const ax = xs[aIndex];
      const ay = ys[aIndex];
      const az = zs[aIndex];
      // XZ eases (so the hop leaves and lands tangentially), Y rises linearly
      // (so a rung ladder drawn along it is evenly spaced). Endpoints are the
      // two leg points themselves, so only the interior is emitted here.
      for (let s = 1; s < RISER_SAMPLES - 1; s++) {
        const t = s / (RISER_SAMPLES - 1);
        const e = smoothstep(t);
        push(ax + (fx - ax) * e, ay + (fy - ay) * t, az + (fz - az) * e, risers.length, t);
      }
      pending = { startIndex: aIndex, fromFloor: from, toFloor: leg.floor, verified };
    }

    const startIndex = push(fx, fy, fz, -1, 0);
    if (pending) {
      risers.push({ ...pending, endIndex: startIndex });
      pending = null;
    }
    let endIndex = startIndex;
    for (let p = 1; p < leg.path.length; p++) {
      const [wx, wy, wz] = planToWorld(place, leg.path[p][0], leg.path[p][1], baseY);
      endIndex = push(wx, wy, wz, -1, 0);
    }
    legs.push({ startIndex, endIndex, floor: leg.floor });
  }

  const count = xs.length;

  // --- endpoint lift ramp -------------------------------------------------
  // Measured along the un-ramped spine; the ramp only moves points vertically by
  // a few feet, so re-deriving the distances afterwards would change nothing
  // that matters and would cost a second pass.
  const base = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    base[i] = base[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1], zs[i] - zs[i - 1]);
  }
  const spanFt = count > 0 ? base[count - 1] : 0;
  const extra = ROUTE_ENDPOINT_LIFT_FT - ROUTE_LIFT_FT;
  for (let i = 0; i < count; i++) {
    if (riserOf[i] >= 0) continue; // handled below, so the hop stays continuous
    const r = Math.max(endRamp(base[i]), endRamp(spanFt - base[i]));
    if (r > 0) ys[i] += extra * r;
  }
  // Riser interiors re-derive from their (possibly ramped) ends. Normally a no-op
  // — a riser is only inside the ramp when a leg is shorter than 8 ft — but it
  // keeps the hop from kinking when that happens.
  for (const r of risers) {
    const ay = ys[r.startIndex];
    const by = ys[r.endIndex];
    for (let i = r.startIndex + 1; i < r.endIndex; i++) {
      if (riserOf[i] >= 0) ys[i] = ay + (by - ay) * riserT[i];
    }
  }

  // --- pack ---------------------------------------------------------------
  const points = new Float32Array(count * 3);
  const cumulative = new Float32Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    points[i * 3] = xs[i];
    points[i * 3 + 1] = ys[i];
    points[i * 3 + 2] = zs[i];
    if (i > 0) {
      total += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1], zs[i] - zs[i - 1]);
    }
    cumulative[i] = total;
  }

  const out: Route3D = {
    points,
    cumulative,
    totalFt: total,
    legs,
    risers,
    stepAnchors: [],
  };
  out.stepAnchors = anchorSteps(out, placements, spread, directions);

  if (import.meta.env.DEV) warnIfMisplaced(out, route, directions);
  return out;
}

/**
 * Bind each `DirectionStep` to a point on the spine, so tapping a step in the
 * panel can fly the 3D camera to it without any new geometry — the same
 * `Directions` object drives both views.
 */
function anchorSteps(
  r: Route3D,
  placements: PlacementSet,
  spread: number,
  directions: Directions | null
): (number | null)[] {
  if (!directions) return [];
  const count = r.cumulative.length;
  return directions.steps.map((step) => {
    if (!step.at || count === 0) return null;
    const [tx, , tz] = planToWorld(
      placements[step.floor],
      step.at[0],
      step.at[1],
      storeyY(step.floor, spread)
    );
    const span = r.legs[step.legIndex];
    // Search this step's own leg first. Compared in XZ only: the step position is
    // a plan coordinate with no height of its own, and the endpoint ramp would
    // otherwise bias the nearest point away from the ends.
    const nearest = (from: number, to: number): { index: number; d2: number } => {
      let index = from;
      let d2 = Infinity;
      for (let i = from; i <= to; i++) {
        const dx = r.points[i * 3] - tx;
        const dz = r.points[i * 3 + 2] - tz;
        const d = dx * dx + dz * dz;
        if (d < d2) {
          d2 = d;
          index = i;
        }
      }
      return { index, d2 };
    };
    const local = span ? nearest(span.startIndex, span.endIndex) : { index: 0, d2: Infinity };
    // A step whose `at` lands far outside the leg it claims would otherwise bind
    // silently to whichever end of the span happens to be closer, which puts the
    // camera in the wrong place. Widen rather than lie.
    if (local.d2 > ANCHOR_FALLBACK_FT * ANCHOR_FALLBACK_FT) {
      return nearest(0, count - 1).index;
    }
    return local.index;
  });
}

/**
 * A single-floor route measures the same walk in both views, so the two totals
 * must agree. When they don't, the floor's placement scale is wrong — this is a
 * data problem masquerading as a rendering problem, and it is worth catching
 * before someone spends a day debugging geometry.
 */
function warnIfMisplaced(r: Route3D, route: GridRoute, directions: Directions | null): void {
  if (!directions || r.risers.length > 0 || directions.totalFeet <= 0) return;
  const drift = Math.abs(r.totalFt - directions.totalFeet) / directions.totalFeet;
  if (drift <= 0.15) return;
  const floor = route.legs[0]?.floor ?? "?";
  console.warn(
    `[routeLift] ${floor}: lifted route is ${r.totalFt.toFixed(0)} ft but the directions say ` +
      `${directions.totalFeet} ft (${(drift * 100).toFixed(0)}% off). ` +
      `On a single-floor route these measure the same walk, so placements["${floor}"].scale is wrong.`
  );
}

export interface SampleAt {
  pos: [number, number, number];
  tangent: [number, number, number];
  /** Fractional storey index: 1 on main, 1.5 halfway up a main→upper riser.
   *  Lets the fly camera and the ghosting logic know which plate it is over
   *  without re-deriving it from the world Y (which moves with `spread`). */
  floorIndexAt: number;
}

/**
 * Position and unit tangent at an arc-length distance along the spine.
 *
 * Binary search plus a lerp — constant work per frame, no curve object
 * allocated, which is what makes the fly-through free to run at 60 fps.
 */
export function sampleAt(r: Route3D, distFt: number): SampleAt {
  const count = r.cumulative.length;
  if (count === 0) {
    return { pos: [0, 0, 0], tangent: [0, 0, 1], floorIndexAt: 0 };
  }
  if (count === 1) {
    return {
      pos: [r.points[0], r.points[1], r.points[2]],
      tangent: [0, 0, 1],
      floorIndexAt: floorIndexAtPoint(r, 0),
    };
  }

  const d = distFt <= 0 ? 0 : distFt >= r.totalFt ? r.totalFt : distFt;
  // Largest i with cumulative[i] <= d, clamped so i+1 is always a real point.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (r.cumulative[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  const i = Math.min(lo, count - 2);

  const segLen = r.cumulative[i + 1] - r.cumulative[i];
  const t = segLen > EPS_FT ? (d - r.cumulative[i]) / segLen : 0;

  const ax = r.points[i * 3];
  const ay = r.points[i * 3 + 1];
  const az = r.points[i * 3 + 2];
  const bx = r.points[i * 3 + 3];
  const by = r.points[i * 3 + 4];
  const bz = r.points[i * 3 + 5];

  let tx = bx - ax;
  let ty = by - ay;
  let tz = bz - az;
  const len = Math.hypot(tx, ty, tz) || 1;
  tx /= len;
  ty /= len;
  tz /= len;

  return {
    pos: [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t],
    tangent: [tx, ty, tz],
    floorIndexAt: floorIndexAtPoint(r, i + t),
  };
}

/**
 * Fractional storey index at a fractional point index. Derived from the spans
 * rather than stored per point: a route has at most a handful of legs, so the
 * scan is cheaper than the array it would replace.
 */
function floorIndexAtPoint(r: Route3D, index: number): number {
  for (const riser of r.risers) {
    if (index > riser.startIndex && index < riser.endIndex) {
      const t = (index - riser.startIndex) / (riser.endIndex - riser.startIndex);
      const a = FLOOR_INDEX[riser.fromFloor];
      return a + (FLOOR_INDEX[riser.toFloor] - a) * t;
    }
  }
  for (const leg of r.legs) {
    if (index >= leg.startIndex && index <= leg.endIndex) return FLOOR_INDEX[leg.floor];
  }
  return r.legs.length > 0 ? FLOOR_INDEX[r.legs[0].floor] : 0;
}
