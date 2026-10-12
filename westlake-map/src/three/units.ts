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
// Tilt.
//
// There used to be a slider for this, next to the drag gesture that already
// did the same thing — two controls for one motion, which is confusing
// rather than generous. Click-and-drag (the OrbitControls rotate gesture)
// is now the only way to tilt, and it drives the camera directly: there is
// no longer a separate 0..1 number the drag has to be translated into and
// back out of.
//
// What still needs a number is the ghost fade below, because it has to track
// the tilt the drag actually produced, continuously, not just at the two ends
// a dial would have offered. `dimensionForElevation` is that one remaining
// piece of the old vocabulary: it takes the camera's actual elevation and
// maps it onto the 0..1 scale the fade math below was written against, so
// that math didn't need to change shape along with the control.
//
// It used to also open and close the storey stack, on the theory that a flat
// plan and an exploded diagram were two ends of one continuum. They are, but
// tying them to one control meant the building changed shape while you were
// trying to change your viewpoint, and a model that reshapes itself under you
// is a model you stop trusting. So the stack is simply always open, and tilt
// is a camera-only effect.

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
  // Linear on purpose. Easing this was tried and makes the transition feel
  // like it sticks at the ends, which for a motion whose whole point is "how
  // tilted" reads as a bug rather than as polish.
  return 90 - 65 * clamp01(dim);
}

/**
 * The inverse of `elevationForDimension`: given the camera's actual
 * elevation (in degrees, 90 = looking straight down), what 0..1 dimension
 * would have produced it. Used to feed a live drag angle into
 * `ghostOpacityForDimension` now that nothing else keeps that number around.
 */
export function dimensionForElevation(elevDeg: number): number {
  return clamp01((90 - elevDeg) / 65);
}

/**
 * The map opens straight down. Not exactly 90: at exactly 90 the camera's
 * heading is undefined and the first rotate gesture jumps.
 */
export const MAP_ELEVATION_DEG = 89.9;

/**
 * How far the map leans back, at most, in degrees from straight down. Enough
 * to see walls and the storeys above and below; not so much that it turns
 * back into a model on a table, which is what a free orbit invited.
 */
export const MAX_TILT_DEG = 50;

/** Where the tilt button leans to. */
export const TILTED_ELEVATION_DEG = 45;

/**
 * How tall the walls are drawn, as a fraction of their real height, at a
 * given camera elevation. Zero looking straight down, where the floor texture
 * already draws every wall as a clean outline. Tilted, they rise only to about
 * a tenth of real height: a lip that gives the plan some depth, the way a
 * phone map extrudes a building footprint, and not the cut-away model that
 * full-height walls turned it into.
 */
export function wallRiseForElevation(elevDeg: number): number {
  const t = clamp01((86 - elevDeg) / 30);
  return 0.1 * (t * t * (3 - 2 * t));
}

/**
 * How much the unfocused storeys fade.
 *
 * Looking straight down, three storeys 110 ft apart project onto exactly the
 * same place, so a visible neighbour turns the floor you are reading to mush.
 * They have to disappear at the plan end. Tilt away and they separate, and the
 * ones below come back — faintly, as footprints, because the map is still a
 * map of one floor.
 */
export function ghostOpacityForDimension(dim: number): number {
  const t = clamp01((clamp01(dim) - 0.12) / 0.3);
  return 0.14 * (t * t * (3 - 2 * t));
}

/** World Y of a storey's slab top. */
export function storeyY(floor: FloorId, spread: number): number {
  return FLOOR_INDEX[floor] * spread;
}
