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
// The 3D dial.
//
// One number, 0..1, runs the whole vertical system, and the slider in the UI is
// that number. It replaces a pair of view modes ("2D Plan" / "3D View") that
// were really the two ends of one continuum, and an implicit rule where the
// stack silently exploded as you orbited upward — which meant the model changed
// shape under you for reasons nobody could see or control.
//
// The three landmarks along the dial each answer a different question:
//
//   0.0  FLAT      one storey, straight down. "Where is 214 on this floor?"
//   0.5  BUILDING  the storeys at their real 16 ft spacing, tilted. "What does
//                  this place actually look like, and what is above me?"
//   1.0  EXPLODED  the storeys pulled far apart. "How do these three floors
//                  line up, and where does this stairwell come out?"
//
// The middle is the honest one and the ends are both useful lies: at 0 the
// building is not flat, and at 1 the floors are not 110 ft apart. Spelling the
// dial out like this is the point — a reader who can slide between them learns
// the layering in a way no static picture teaches.

/** Storeys at their real spacing. Matches FLOOR_HEIGHT in directions.ts. */
export const SPREAD_COMPACT = 16;
// 40 ft was not enough. On a building 1200 ft across, three storeys that close
// together read as one surface from any sensible camera angle: you see Main's
// 2xx room numbers and Upper's 3xx numbers side by side and assume they are on
// the same floor. At 110 ft the trays are unmistakably separate and it is still
// only 9% of the building's width, so it never reads as a tower.
export const SPREAD_EXPLODED = 110;

/** Where "BUILDING" sits on the dial. Below it the stack closes toward flat. */
const DIM_BUILDING = 0.5;

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * Storey separation for a dial position.
 *
 * Two segments, because the two halves of the dial are doing different jobs:
 * below BUILDING the stack is closing up toward a single readable plane, above
 * it the stack is opening into a diagram.
 */
export function spreadForDimension(dim: number): number {
  const d = clamp01(dim);
  if (d <= DIM_BUILDING) {
    return SPREAD_COMPACT * smooth(d / DIM_BUILDING);
  }
  const t = smooth((d - DIM_BUILDING) / (1 - DIM_BUILDING));
  return SPREAD_COMPACT + (SPREAD_EXPLODED - SPREAD_COMPACT) * t;
}

/**
 * Camera elevation above the horizon for a dial position, in degrees.
 *
 * Straight down at 0 so the flat end really is a plan. It does not fall
 * monotonically to the horizon, though: a fully exploded stack viewed from low
 * down is three trays edge-on, hiding each other. So the tilt bottoms out around
 * the BUILDING mark and comes back up for the exploded end, which is where you
 * need to see *into* each tray.
 */
export function elevationForDimension(dim: number): number {
  const d = clamp01(dim);
  if (d <= DIM_BUILDING) {
    // 90° (straight down) -> 32° (an architectural three-quarter view)
    return 90 - 58 * smooth(d / DIM_BUILDING);
  }
  // 32° -> 40°. Only a little: elevation is a trade here, because looking down
  // more steeply is what lets you see into each tray and is also what squashes
  // the gaps between them. 40° keeps the three trays visibly apart while still
  // showing their floors.
  return 32 + 8 * smooth((d - DIM_BUILDING) / (1 - DIM_BUILDING));
}

/**
 * How much the unfocused storeys fade.
 *
 * Two things pull in opposite directions. Near the flat end the storeys sit on
 * top of each other, so a visible neighbour turns the floor you are reading to
 * mush — they have to disappear. Near the exploded end they are far apart and
 * are the entire point of the view, so they need to be solid enough to read.
 */
export function ghostOpacityForDimension(dim: number): number {
  const d = clamp01(dim);
  const fadeIn = smooth(Math.min(1, d / 0.22));
  const open = smooth(clamp01((d - DIM_BUILDING) / (1 - DIM_BUILDING)));
  return (0.4 + 0.35 * open) * fadeIn;
}

export const DIMENSION_STOPS = [
  { at: 0, label: "Flat" },
  { at: DIM_BUILDING, label: "Building" },
  { at: 1, label: "Exploded" },
] as const;

/** World Y of a storey's slab top. */
export function storeyY(floor: FloorId, spread: number): number {
  return FLOOR_INDEX[floor] * spread;
}
