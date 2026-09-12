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

// You cannot see into a building from outside, so the stack opens up. But an
// exploded stack seen near the horizon looks broken, so the spread is a
// function of how far above the horizon the camera is: orbit down and the
// model collapses into a building, orbit up and it opens into a diagram.
export const SPREAD_COMPACT = 16;
// 40 ft was not enough. On a building 1200 ft across, three storeys that close
// together read as one surface from any sensible camera angle: you see Main's
// 2xx room numbers and Upper's 3xx numbers side by side and assume they are on
// the same floor. At 110 ft the trays are unmistakably separate and it is still
// only 9% of the building's width, so it never reads as a tower.
export const SPREAD_EXPLODED = 110;

const ELEV_LO = (8 * Math.PI) / 180;
const ELEV_HI = (30 * Math.PI) / 180;

export function spreadForElevation(elevRad: number): number {
  const t = Math.min(1, Math.max(0, (elevRad - ELEV_LO) / (ELEV_HI - ELEV_LO)));
  const s = t * t * (3 - 2 * t);
  return SPREAD_COMPACT + (SPREAD_EXPLODED - SPREAD_COMPACT) * s;
}

/** World Y of a storey's slab top. */
export function storeyY(floor: FloorId, spread: number): number {
  return FLOOR_INDEX[floor] * spread;
}
