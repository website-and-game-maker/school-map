// Where each storey sits relative to the others.
//
// The three plan sheets are separate scans at different scales with no shared
// registration marks, so this is a data problem before it is a rendering one.
//
// Two things were tried and rejected, both recorded in tools/seed_align.py:
//
//  1. floorAlign.ts's fitTransform. It fits a full similarity (scale, rotation,
//     translation) per pair, and is right for the job it already does — asking
//     whether two stair markers are the same stairwell, a question with tens of
//     feet of slack. It is wrong here: the pairwise fits are mutually
//     inconsistent (composing lower->main->upper disagrees with lower->upper),
//     and main->upper has exactly two correspondences, so a 4-DOF fit matches
//     them perfectly and its rotation is pure noise.
//
//  2. Registering the wall or footprint masks by correlation. Tempting, because
//     a mask has tens of thousands of constraints instead of six. It fails
//     because the storeys genuinely differ in extent — upper has wings main does
//     not, lower is a partial basement — so maximising overlap slides one storey
//     inside the other's mass. Measured: it put the shared entrances 220-400 ft
//     apart and the overlay was visibly wrong.
//
// What ships (tools/register_floors.py): every sheet also draws the other
// levels' outlines — Lower outlines the whole building, Main marks the Lower
// gym, cafeteria and Black Box and hatches the Upper gym, Upper outlines
// Main's middle — so the sheets share the same physical walls. Lower and Upper
// are fitted onto Main together (scale, rotation and translation) by matching
// those long strokes across all three pairs at once. Still unverified: a fit
// to drawings, not a survey.

import type { FloorId } from "../types";
import { sitePxToWorldXZ, worldXZToSitePx } from "./units";
import align3d from "../data/floors/align3d.json";

export interface FloorPlacement {
  floor: FloorId;
  scale: number;
  /** Degrees; a fraction of one, from the scans' own skew. */
  rotationDeg: number;
  tx: number;
  ty: number;
  verified: boolean;
}

export type PlacementSet = Record<FloorId, FloorPlacement>;

export function loadPlacements(): PlacementSet {
  return align3d as unknown as PlacementSet;
}

/** That floor's plan pixels -> the shared site frame (which is main's pixels). */
export function planToSite(p: FloorPlacement, x: number, y: number): [number, number] {
  const t = (p.rotationDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    p.scale * (c * x - s * y) + p.tx,
    p.scale * (s * x + c * y) + p.ty,
  ];
}

export function siteToPlan(p: FloorPlacement, sx: number, sy: number): [number, number] {
  const t = (-p.rotationDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = (sx - p.tx) / p.scale;
  const dy = (sy - p.ty) / p.scale;
  return [c * dx - s * dy, s * dx + c * dy];
}

/**
 * The only conversion the rest of the 3D code should call.
 * `worldY` is supplied by the caller (usually storeyY of that floor).
 */
export function planToWorld(
  p: FloorPlacement,
  x: number,
  y: number,
  worldY: number
): [number, number, number] {
  const [sx, sy] = planToSite(p, x, y);
  const [wx, wz] = sitePxToWorldXZ(sx, sy);
  return [wx, worldY, wz];
}

/** What a raycast hit on a floor plate means, so a 3D click can feed the same
 *  snap()/search code the 2D view uses. */
export function worldToPlan(p: FloorPlacement, x: number, z: number): [number, number] {
  const [sx, sy] = worldXZToSitePx(x, z);
  return siteToPlan(p, sx, sy);
}
