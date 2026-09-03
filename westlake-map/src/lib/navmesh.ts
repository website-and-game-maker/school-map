// Turns the hand-edited hallway graph (points + edges) into an actual walkable
// AREA — a "ribbon" of the given half-width around every edge — and finds
// paths through that area with grid A*, instead of just connecting the dots
// with a straight line. This is what stops routes from cutting through walls
// that happen to sit between two graph points: the rendered path can only go
// where the ribbon actually is.
//
// Editing the graph (Edit mode: Move / Connect / +Hallway point) is still how
// you fix a bad route — this module just turns whatever graph exists right
// now into geometry, every time it's asked to.

import type { FloorData } from "../types";

const CELL = 6; // source-image px per grid cell
const HALF_WIDTH = 26; // px either side of an edge's centerline that counts as walkable

export interface WalkGrid {
  cols: number;
  rows: number;
  cellSize: number;
  originX: number;
  originY: number;
  open: Uint8Array; // 1 = walkable, indexed row * cols + col
}

function idx(g: WalkGrid, c: number, r: number) {
  return r * g.cols + c;
}

function isOpen(g: WalkGrid, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return false;
  return g.open[idx(g, c, r)] === 1;
}

export function buildWalkGrid(floor: FloorData, halfWidth = HALF_WIDTH): WalkGrid {
  const cols = Math.ceil(floor.image.w / CELL);
  const rows = Math.ceil(floor.image.h / CELL);
  const grid: WalkGrid = { cols, rows, cellSize: CELL, originX: 0, originY: 0, open: new Uint8Array(cols * rows) };

  for (const e of floor.edges) {
    const a = floor.points[e.a];
    const b = floor.points[e.b];
    if (!a || !b) continue;
    stampCapsule(grid, a.x, a.y, b.x, b.y, halfWidth);
  }
  // also stamp a small disc at every point, so isolated/POI points (and any
  // point whose edge got deleted mid-edit) stay walkable at their own spot
  for (const p of Object.values(floor.points)) {
    stampCapsule(grid, p.x, p.y, p.x, p.y, Math.max(halfWidth * 0.6, 14));
  }

  return grid;
}

function stampCapsule(g: WalkGrid, ax: number, ay: number, bx: number, by: number, halfWidth: number) {
  const minX = Math.max(0, Math.floor((Math.min(ax, bx) - halfWidth) / CELL));
  const maxX = Math.min(g.cols - 1, Math.ceil((Math.max(ax, bx) + halfWidth) / CELL));
  const minY = Math.max(0, Math.floor((Math.min(ay, by) - halfWidth) / CELL));
  const maxY = Math.min(g.rows - 1, Math.ceil((Math.max(ay, by) + halfWidth) / CELL));

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  for (let r = minY; r <= maxY; r++) {
    for (let c = minX; c <= maxX; c++) {
      const px = c * CELL + CELL / 2;
      const py = r * CELL + CELL / 2;
      let dist: number;
      if (lenSq === 0) {
        dist = Math.hypot(px - ax, py - ay);
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        dist = Math.hypot(px - cx, py - cy);
      }
      if (dist <= halfWidth) g.open[idx(g, c, r)] = 1;
    }
  }
}

function nearestOpenCell(g: WalkGrid, x: number, y: number, maxRing = 60): [number, number] | null {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  if (isOpen(g, cx, cy)) return [cx, cy];
  for (let r = 1; r <= maxRing; r++) {
    for (let dx = -r; dx <= r; dx++) {
      if (isOpen(g, cx + dx, cy - r)) return [cx + dx, cy - r];
      if (isOpen(g, cx + dx, cy + r)) return [cx + dx, cy + r];
    }
    for (let dy = -r + 1; dy <= r - 1; dy++) {
      if (isOpen(g, cx - r, cy + dy)) return [cx - r, cy + dy];
      if (isOpen(g, cx + r, cy + dy)) return [cx + r, cy + dy];
    }
  }
  return null;
}

interface Node {
  f: number;
  g: number;
  c: number;
  r: number;
}

// Small binary min-heap keyed on f-score — grids can be tens of thousands of
// cells and a plain array scan is noticeably slower for longer routes.
class MinHeap {
  private items: Node[] = [];
  get size() {
    return this.items.length;
  }
  push(n: Node) {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Node | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r2 = i * 2 + 2;
        let smallest = i;
        if (l < a.length && a[l].f < a[smallest].f) smallest = l;
        if (r2 < a.length && a[r2].f < a[smallest].f) smallest = r2;
        if (smallest === i) break;
        [a[smallest], a[i]] = [a[i], a[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function gridAStar(
  g: WalkGrid,
  start: [number, number],
  goal: [number, number]
): [number, number][] | null {
  const [sc, sr] = start;
  const [gc, gr] = goal;
  const key = (c: number, r: number) => r * g.cols + c;
  const gScore = new Map<number, number>();
  const came = new Map<number, number>();
  const heap = new MinHeap();
  const h = (c: number, r: number) => Math.hypot(c - gc, r - gr);

  gScore.set(key(sc, sr), 0);
  heap.push({ f: h(sc, sr), g: 0, c: sc, r: sr });
  const closed = new Set<number>();

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const ck = key(cur.c, cur.r);
    if (closed.has(ck)) continue;
    if (cur.g > (gScore.get(ck) ?? Infinity)) continue;
    closed.add(ck);
    if (cur.c === gc && cur.r === gr) {
      const path: [number, number][] = [[cur.c, cur.r]];
      let k = ck;
      while (came.has(k)) {
        k = came.get(k)!;
        const r = Math.floor(k / g.cols);
        const c = k - r * g.cols;
        path.push([c, r]);
      }
      path.reverse();
      return path;
    }
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const nc = cur.c + dc;
        const nr = cur.r + dr;
        if (!isOpen(g, nc, nr)) continue;
        if (dc !== 0 && dr !== 0) {
          // no cutting diagonally across a wall corner
          if (!isOpen(g, cur.c + dc, cur.r) || !isOpen(g, cur.c, cur.r + dr)) continue;
        }
        const step = dc !== 0 && dr !== 0 ? Math.SQRT2 : 1;
        const ng = cur.g + step;
        const nk = key(nc, nr);
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, ck);
          heap.push({ f: ng + h(nc, nr), g: ng, c: nc, r: nr });
        }
      }
    }
  }
  return null;
}

function hasLineOfSight(g: WalkGrid, a: [number, number], b: [number, number]): boolean {
  // Bresenham over grid cells; every cell the line touches must be open.
  let [x0, y0] = a;
  let [x1, y1] = b;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (!isOpen(g, x0, y0)) return false;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return true;
}

function simplify(g: WalkGrid, path: [number, number][]): [number, number][] {
  if (path.length <= 2) return path;
  const out: [number, number][] = [path[0]];
  let anchor = 0;
  for (let i = 1; i < path.length; i++) {
    if (!hasLineOfSight(g, path[anchor], path[i])) {
      out.push(path[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

function cellToPx(g: WalkGrid, c: number, r: number): [number, number] {
  return [c * g.cellSize + g.cellSize / 2, r * g.cellSize + g.cellSize / 2];
}

// Wall-aware path between two pixel-space points on one floor. Falls back to
// a straight line if the grid has no route (e.g. the two points genuinely
// aren't connected by any edge yet) so the UI still shows *something*.
export function wallAwarePath(
  g: WalkGrid,
  startXY: [number, number],
  endXY: [number, number]
): [number, number][] {
  const s = nearestOpenCell(g, startXY[0], startXY[1]);
  const e = nearestOpenCell(g, endXY[0], endXY[1]);
  if (!s || !e) return [startXY, endXY];
  const cellPath = gridAStar(g, s, e);
  if (!cellPath) return [startXY, endXY];
  const simplified = simplify(g, cellPath);
  const pxPath = simplified.map(([c, r]) => cellToPx(g, c, r));
  return [startXY, ...pxPath, endXY];
}
