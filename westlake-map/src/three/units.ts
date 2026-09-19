// World units and the vertical system for the 3D view.
//
// World unit = one foot, and the scale comes from PX_PER_FOOT in
// lib/directions.ts — never redeclared here. That constant is the app's single
// scale calibration, and the 3D view must inherit it so a distance in the
// directions panel and a distance in the scene are the same distance.
//
// Axes:
//   plan +x  ->  world +X   (east on the page)
//   plan +y  ->  world +Z   (south; plan y grows downward)
//   storey   ->  world +Y   (up)
//
// A camera at +Y looking down with up = (0, 0, -1) therefore reproduces the 2D
// view exactly, with no mirroring and no handedness flip, which is what keeps
// the scan's text reading correctly when it is used as the floor texture.

import { PX_PER_FOOT } from "../lib/directions";
import type { FloorId } from "../types";

/** Main's page centre (3167 x 2448). Everything is expressed relative to it. */
export const SITE_ORIGIN: readonly [number, number] = [1583.5, 1224];

/**
 * Centring on main's page centre keeps the model within about ±600 ft of the
 * origin, which is comfortable for float32 and gives the orbit controls a sane
 * default target.
 */
export function sitePxToWorldXZ(sx: number, sy: number): [number, number] {
  return [(sx - SITE_ORIGIN[0]) / PX_PER_FOOT, (sy - SITE_ORIGIN[1]) / PX_PER_FOOT];
}

export function worldXZToSitePx(x: number, z: number): [number, number] {
  return [x * PX_PER_FOOT + SITE_ORIGIN[0], z * PX_PER_FOOT + SITE_ORIGIN[1]];
}

/** Matches FLOOR_HEIGHT in directions.ts, so "up" in the text and "up" in the
 *  geometry can never disagree. */
export const FLOOR_INDEX: Record<FloorId, number> = { lower: 0, main: 1, upper: 2 };

// Heights. Like PX_PER_FOOT these are stated assumptions, not measurements of
// this building — correct them here if anyone ever measures the real thing.
export const WALL_H_INTERIOR = 10.5;
export const WALL_H_PERIMETER = 13.5;
export const SLAB_THICKNESS = 2.5;
export const GROUND_Y = -8;

// ---------------------------------------------------------------------------
// The tilt dial.
//
// One number, 0..1, and it does exactly one thing: it swings the camera between
// looking straight down and looking across. Nothing else about the model moves.
//
// It used to also open and close the storey stack, on the theory that a flat
// plan and an exploded diagram were two ends of one continuum. They are, but
// tying them to one control meant the building changed shape while you were
// trying to change your viewpoint, and a model that reshapes itself under you
// is a model you stop trusting. So the stack is simply always open, and the
// dial is a camera control.

// Storey separation, fixed. On a building 1200 ft across, three storeys any
// closer than this read as one surface from any sensible angle: you see Main's
// 2xx room numbers and Upper's 3xx numbers side by side and assume they are on
// the same floor. At 110 ft the trays are unmistakably separate and it is still
// only 9% of the building's width, so it never reads as a tower.
export const SPREAD = 110;

/** Matches FLOOR_HEIGHT in directions.ts — the storeys' real spacing. */
export const SPREAD_COMPACT = 16;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Camera elevation above the horizon, in degrees. 0 = plan, 1 = across. */
export function elevationForDimension(dim: number): number {
  // Linear on purpose. Easing this was tried and makes the slider feel like it
  // sticks at the ends, which on a control whose whole job is "how tilted"
  // reads as a bug rather than as polish.
  return 90 - 65 * clamp01(dim);
}

/**
 * How much the unfocused storeys fade.
 *
 * Looking straight down, three storeys 110 ft apart project onto exactly the
 * same place, so a visible neighbour turns the floor you are reading to mush.
 * They have to disappear at the plan end. Tilt away and they separate, and then
 * they are the entire point of the view, so they come back.
 */
export function ghostOpacityForDimension(dim: number): number {
  const t = clamp01((clamp01(dim) - 0.12) / 0.3);
  return 0.72 * (t * t * (3 - 2 * t));
}

/** World Y of a storey's slab top. */
export function storeyY(floor: FloorId, spread: number): number {
  return FLOOR_INDEX[floor] * spread;
}
