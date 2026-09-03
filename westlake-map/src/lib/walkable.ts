// The walkable masks are traced from the scan itself, not by hand: every cell
// that is paper (not ink) and inside the building footprint. See
// tools/walkmask.py for how they're generated — rerun it if the plan images
// are ever replaced.
//
// Stored bit-packed and base64'd because a mask is ~215,000 booleans per floor
// and JSON arrays of that would be absurd.

import lowerMask from "../data/floors/walkable-lower.json";
import mainMask from "../data/floors/walkable-main.json";
import upperMask from "../data/floors/walkable-upper.json";
import type { FloorId } from "../types";

export interface WalkMask {
  cols: number;
  rows: number;
  cell: number;
  open: Uint8Array; // 1 = inside the building and not a wall
}

interface RawMask {
  cols: number;
  rows: number;
  cell: number;
  bits: string;
}

function decode(raw: RawMask): WalkMask {
  const packed = atob(raw.bits);
  const open = new Uint8Array(raw.cols * raw.rows);
  for (let i = 0; i < open.length; i++) {
    const byte = packed.charCodeAt(i >> 3);
    open[i] = (byte >> (7 - (i & 7))) & 1;
  }
  return { cols: raw.cols, rows: raw.rows, cell: raw.cell, open };
}

let cache: Record<FloorId, WalkMask> | null = null;

export function walkMasks(): Record<FloorId, WalkMask> {
  if (!cache) {
    cache = {
      lower: decode(lowerMask as RawMask),
      main: decode(mainMask as RawMask),
      upper: decode(upperMask as RawMask),
    };
  }
  return cache;
}
