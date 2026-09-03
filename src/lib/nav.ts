// Navigation grids traced from the scans themselves (see tools/mask4.py and
// tools/export_nav.py). Four bit-planes per floor on a 6px grid:
//
//   walk   standable floor, with doorways carved open
//   pub    circulation space — hallway rather than the inside of a classroom
//   east   a step to the right is legal: no ink between the two cell centres
//   south  the same, downwards
//
// The step planes are what make walls real. Deciding walkability per cell
// alone lets a route slip through a wall that happens to fall between two open
// cells; checking the pixels *between* centres can't.

import navLower from "../data/floors/nav-lower.json";
import navMain from "../data/floors/nav-main.json";
import navUpper from "../data/floors/nav-upper.json";
import type { FloorId } from "../types";

export interface NavGrid {
  cols: number;
  rows: number;
  cell: number;
  walk: Uint8Array;
  pub: Uint8Array;
  east: Uint8Array;
  south: Uint8Array;
  clearance: Uint8Array; // cells to the nearest blocked cell, capped
  net: Uint8Array; // 1 = part of the building's main connected network
  doors: [number, number][];
}

interface RawNav {
  cols: number;
  rows: number;
  cell: number;
  walk: string;
  pub: string;
  east: string;
  south: string;
  doors: [number, number][];
}

function unpack(b64: string, size: number): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = (bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
  }
  return out;
}

// Two-pass chamfer: how far each cell is from the nearest blocked one. Used to
// keep routes off the walls rather than scraping along them.
function clearanceOf(walk: Uint8Array, cols: number, rows: number): Uint8Array {
  const d = new Uint16Array(cols * rows);
  const INF = 9999;
  for (let i = 0; i < d.length; i++) d[i] = walk[i] ? INF : 0;
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : d[r * cols + c]);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(c - 1, r) + 3, at(c, r - 1) + 3, at(c - 1, r - 1) + 4, at(c + 1, r - 1) + 4);
    }
  for (let r = rows - 1; r >= 0; r--)
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(c + 1, r) + 3, at(c, r + 1) + 3, at(c + 1, r + 1) + 4, at(c - 1, r + 1) + 4);
    }
  const out = new Uint8Array(cols * rows);
  for (let i = 0; i < d.length; i++) out[i] = Math.min(Math.round(d[i] / 3), 255);
  return out;
}

// Largest connected set of cells, following the legal-step planes. A point
// that snaps to some isolated pocket — a closet the plan seals off, a sliver
// between two walls — is unroutable, so snapping has to land here instead.
function network(
  walk: Uint8Array,
  east: Uint8Array,
  south: Uint8Array,
  cols: number,
  rows: number
): Uint8Array {
  const size = cols * rows;
  const comp = new Int32Array(size).fill(-1);
  const stack = new Int32Array(size);
  let best = -1;
  let bestSize = 0;
  let id = 0;
  for (let seed = 0; seed < size; seed++) {
    if (!walk[seed] || comp[seed] >= 0) continue;
    let top = 0;
    stack[top++] = seed;
    comp[seed] = id;
    let count = 0;
    while (top > 0) {
      const i = stack[--top];
      count++;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      const visit = (j: number) => {
        if (comp[j] < 0 && walk[j]) {
          comp[j] = id;
          stack[top++] = j;
        }
      };
      if (c + 1 < cols && east[i] === 1) visit(i + 1);
      if (c > 0 && east[i - 1] === 1) visit(i - 1);
      if (r + 1 < rows && south[i] === 1) visit(i + cols);
      if (r > 0 && south[i - cols] === 1) visit(i - cols);
    }
    if (count > bestSize) {
      bestSize = count;
      best = id;
    }
    id++;
  }
  const net = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (comp[i] === best) net[i] = 1;
  return net;
}

function decode(raw: RawNav): NavGrid {
  const size = raw.cols * raw.rows;
  const walk = unpack(raw.walk, size);
  const east = unpack(raw.east, size);
  const south = unpack(raw.south, size);
  return {
    cols: raw.cols,
    rows: raw.rows,
    cell: raw.cell,
    walk,
    pub: unpack(raw.pub, size),
    east,
    south,
    clearance: clearanceOf(walk, raw.cols, raw.rows),
    net: network(walk, east, south, raw.cols, raw.rows),
    doors: raw.doors ?? [],
  };
}

let cache: Record<FloorId, NavGrid> | null = null;

export function navGrids(): Record<FloorId, NavGrid> {
  if (!cache) {
    cache = {
      lower: decode(navLower as unknown as RawNav),
      main: decode(navMain as unknown as RawNav),
      upper: decode(navUpper as unknown as RawNav),
    };
  }
  return cache;
}

export function cellOf(g: NavGrid, x: number, y: number): number {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor(x / g.cell)));
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.cell)));
  return r * g.cols + c;
}

export function centreOf(g: NavGrid, cell: number): [number, number] {
  const r = Math.floor(cell / g.cols);
  const c = cell - r * g.cols;
  return [c * g.cell + g.cell / 2, r * g.cell + g.cell / 2];
}

/**
 * Nearest usable cell to a point on the plan. A room's label often sits on top
 * of ink, and the nearest *walkable* cell can be a sealed-off sliver, so this
 * insists on the connected network first and only then relaxes.
 */
export function snap(g: NavGrid, x: number, y: number, preferPublic = false, maxRing = 45): number | null {
  const c0 = Math.floor(x / g.cell);
  const r0 = Math.floor(y / g.cell);

  const search = (accept: (i: number) => boolean): number | null => {
    const ok = (c: number, r: number) => {
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return false;
      return accept(r * g.cols + c);
    };
    if (ok(c0, r0)) return r0 * g.cols + c0;
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let d = -ring; d <= ring; d++) {
        if (ok(c0 + d, r0 - ring)) return (r0 - ring) * g.cols + c0 + d;
        if (ok(c0 + d, r0 + ring)) return (r0 + ring) * g.cols + c0 + d;
        if (ok(c0 - ring, r0 + d)) return (r0 + d) * g.cols + c0 - ring;
        if (ok(c0 + ring, r0 + d)) return (r0 + d) * g.cols + c0 + ring;
      }
    }
    return null;
  };

  if (preferPublic) {
    const onPublicNet = search((i) => g.net[i] === 1 && g.pub[i] === 1);
    if (onPublicNet != null) return onPublicNet;
  }
  return search((i) => g.net[i] === 1) ?? search((i) => g.walk[i] === 1);
}
