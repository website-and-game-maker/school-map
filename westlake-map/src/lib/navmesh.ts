// Turns the hand-edited hallway graph (points + edges) into an actual walkable
// AREA — a "ribbon" of hallway width around every edge — and finds paths
// through that area with grid A*, instead of just connecting the dots with a
// straight line. This is what stops routes from cutting through walls that
// happen to sit between two graph points: the drawn path can only go where the
// ribbon actually is.
//
// Two refinements make the line look like a route a person would walk rather
// than a raw grid path:
//   1. A clearance field (distance from each walkable cell to the nearest
//      non-walkable one) biases A* toward the MIDDLE of the ribbon, so routes
//      run down the centre of a hallway instead of scraping along one wall.
//   2. The resulting path is simplified with a clearance-aware line-of-sight
//      pass and then corner-rounded, so it reads as a smooth walking line.
//
// Editing the graph (Edit mode: Move / Connect / +Hallway point) is still how
// you fix a genuinely wrong route — this module just turns whatever graph
// exists right now into geometry, every time it's asked to.

import type { WalkMask } from "./walkable";
import type { FloorData } from "../types";

const CELL = 6; // source-image px per grid cell
const HALF_WIDTH = 26; // px either side of an edge's centerline that counts as walkable

// How strongly to prefer the middle of a corridor. 0 = don't care (hugs walls
// on the inside of every corner), too high = long detours to stay centred.
const CENTER_BIAS = 1.2;
// Clearance (in cells) at which a cell counts as "comfortably in the middle".
// A corridor is only ~2 cells of clearance, so aiming higher would penalise
// every hallway equally and quietly bias routes through wide-open rooms.
const COMFORT_CLEARANCE = 2;

// Cells the traced graph doesn't know about are still walkable — that's the
// whole point of using the scan — but the traced hallways are the routes a
// person is actually meant to take, so drifting away from them costs more.
const OFF_ROUTE_BIAS = 1.4;
const OFF_ROUTE_RANGE = 26; // cells (~150 px) at which the penalty maxes out

// Last resort: a cell the mask says is wall. Reachable only because the traced
// graph claims a hallway runs there, which happens where a door is drawn shut
// in the scan. Expensive enough that any real corridor wins.
const THROUGH_WALL_COST = 14;

export interface WalkGrid {
  cols: number;
  rows: number;
  cellSize: number;
  open: Uint8Array; // 1 = walkable, indexed row * cols + col
  clearance: Uint16Array; // cells to the nearest blocked cell (0 if blocked)
  inMask: Uint8Array; // 1 = the scan says this is real open floor
  offRoute: Uint16Array; // cells to the nearest traced-hallway cell
}

function idx(g: { cols: number }, c: number, r: number) {
  return r * g.cols + c;
}

function isOpen(g: WalkGrid, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return false;
  return g.open[idx(g, c, r)] === 1;
}

function clearanceAt(g: WalkGrid, c: number, r: number): number {
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return 0;
  return g.clearance[idx(g, c, r)];
}

/**
 * Two sources of truth, combined.
 *
 * The scan knows exactly where the walls are, but not which open space is a
 * hallway you're meant to walk down versus the inside of somebody's classroom.
 * The hand-traced graph knows where the hallways are, but its straight lines
 * between points cheerfully cross walls. So: walkable space comes from the
 * mask, the traced graph biases which walkable space gets used, and the
 * ribbon around the graph is kept as a very expensive fallback for the places
 * where the scan shows a door drawn shut.
 */
export function buildWalkGrid(
  floor: FloorData,
  mask: WalkMask | null,
  halfWidth = HALF_WIDTH
): WalkGrid {
  const cols = Math.ceil(floor.image.w / CELL);
  const rows = Math.ceil(floor.image.h / CELL);
  const size = cols * rows;
  const grid: WalkGrid = {
    cols,
    rows,
    cellSize: CELL,
    open: new Uint8Array(size),
    clearance: new Uint16Array(size),
    inMask: new Uint8Array(size),
    offRoute: new Uint16Array(size),
  };

  if (mask && mask.cols === cols && mask.rows === rows && mask.cell === CELL) {
    grid.inMask.set(mask.open);
    grid.open.set(mask.open);
  }

  // The traced hallways, as a ribbon: both the fallback walkable space and the
  // "this is a real route" hint.
  const ribbon = new Uint8Array(size);
  const ribbonGrid: WalkGrid = { ...grid, open: ribbon };
  for (const e of floor.edges) {
    const a = floor.points[e.a];
    const b = floor.points[e.b];
    if (!a || !b) continue;
    stampCapsule(ribbonGrid, a.x, a.y, b.x, b.y, halfWidth);
  }
  // A small disc at every point too, so an isolated point (a POI, or one whose
  // edge got deleted mid-edit) stays reachable at its own spot.
  for (const p of Object.values(floor.points)) {
    stampCapsule(ribbonGrid, p.x, p.y, p.x, p.y, Math.max(halfWidth * 0.6, 14));
  }
  for (let i = 0; i < size; i++) if (ribbon[i]) grid.open[i] = 1;

  computeClearance(grid);
  computeDistanceFrom(grid, ribbon, grid.offRoute);
  return grid;
}

function stampCapsule(
  g: WalkGrid,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  halfWidth: number
) {
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
        dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (dist <= halfWidth) g.open[idx(g, c, r)] = 1;
    }
  }
}

// Two-pass chamfer distance transform (3-4 weights, then scaled back to whole
// cells). Cheap, and plenty accurate for "am I near the edge of the hallway".
function computeClearance(g: WalkGrid) {
  const { cols, rows, open, clearance } = g;
  const INF = 65535;
  const d = new Uint16Array(cols * rows);
  for (let i = 0; i < d.length; i++) d[i] = open[i] === 1 ? INF : 0;

  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : d[r * cols + c]);
  // forward pass
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (d[i] === 0) continue;
      let v = d[i];
      v = Math.min(v, at(c - 1, r) + 3, at(c, r - 1) + 3, at(c - 1, r - 1) + 4, at(c + 1, r - 1) + 4);
      d[i] = v;
    }
  }
  // backward pass
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (d[i] === 0) continue;
      let v = d[i];
      v = Math.min(v, at(c + 1, r) + 3, at(c, r + 1) + 3, at(c + 1, r + 1) + 4, at(c - 1, r + 1) + 4);
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) clearance[i] = Math.round(d[i] / 3);
}

// Same chamfer pass, but measuring distance out from an arbitrary seed set
// (here: the traced hallway ribbon) rather than from walls.
function computeDistanceFrom(g: WalkGrid, seeds: Uint8Array, out: Uint16Array) {
  const { cols, rows } = g;
  const INF = 60000;
  const d = new Uint16Array(cols * rows);
  for (let i = 0; i < d.length; i++) d[i] = seeds[i] ? 0 : INF;
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? INF : d[r * cols + c]);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(c - 1, r) + 3, at(c, r - 1) + 3, at(c - 1, r - 1) + 4, at(c + 1, r - 1) + 4);
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(c + 1, r) + 3, at(c, r + 1) + 3, at(c + 1, r + 1) + 4, at(c - 1, r + 1) + 4);
    }
  }
  for (let i = 0; i < d.length; i++) out[i] = Math.min(Math.round(d[i] / 3), 60000);
}

/**
 * What one step into this cell really costs.
 *
 *  - scraping along a wall costs more than walking down the middle
 *  - wandering away from a traced hallway costs more than following one
 *  - and crossing a cell the scan says is solid wall costs a lot, so it only
 *    happens where there is genuinely no other way through (a door the plan
 *    draws closed)
 */
function cellCost(g: WalkGrid, c: number, r: number): number {
  const i = idx(g, c, r);
  if (g.inMask[i] !== 1) return THROUGH_WALL_COST;

  const clr = clearanceAt(g, c, r);
  const center =
    clr >= COMFORT_CLEARANCE ? 1 : 1 + CENTER_BIAS * ((COMFORT_CLEARANCE - clr) / COMFORT_CLEARANCE);

  const off = Math.min(g.offRoute[i] / OFF_ROUTE_RANGE, 1);
  return center * (1 + OFF_ROUTE_BIAS * off);
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

// Small binary min-heap keyed on f-score — grids run to hundreds of thousands
// of cells and a plain array scan is noticeably slower on longer routes.
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

function gridAStar(g: WalkGrid, start: [number, number], goal: [number, number]): [number, number][] | null {
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
        path.push([k - r * g.cols, r]);
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
        const step = (dc !== 0 && dr !== 0 ? Math.SQRT2 : 1) * cellCost(g, nc, nr);
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

// Bresenham over grid cells; every cell the line touches must be open, and (if
// minClearance is given) must also sit at least that far from a wall. The
// clearance floor is what stops simplification from undoing the centring work
// by cutting a shortcut tight around an inside corner.
function hasLineOfSight(
  g: WalkGrid,
  a: [number, number],
  b: [number, number],
  minClearance = 0,
  requireMask = true
): boolean {
  let [x0, y0] = a;
  const [x1, y1] = b;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (!isOpen(g, x0, y0)) return false;
    // A straightened shortcut must stay on floor the scan actually shows as
    // open — otherwise simplification would undo the wall-avoidance by cutting
    // the corner through a classroom.
    if (requireMask && g.inMask[idx(g, x0, y0)] !== 1) return false;
    if (minClearance > 0 && clearanceAt(g, x0, y0) < minClearance) return false;
    if (x0 === x1 && y0 === y1) return true;
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
}

function simplify(g: WalkGrid, path: [number, number][]): [number, number][] {
  if (path.length <= 2) return path;
  // Shortcuts have to keep a bit of breathing room from walls; near a doorway
  // (where clearance is genuinely low) fall back to allowing a tight shortcut
  // so we never fail to simplify at all.
  const minClr = Math.max(1, COMFORT_CLEARANCE - 1);
  const out: [number, number][] = [path[0]];
  let anchor = 0;
  for (let i = 1; i < path.length; i++) {
    const clear =
      hasLineOfSight(g, path[anchor], path[i], minClr) || hasLineOfSight(g, path[anchor], path[i], 0);
    if (!clear) {
      out.push(path[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

// Chaikin-style corner rounding, but only where the rounded corner still fits
// inside the walkable area — a route with softened corners reads much more
// like a walking line than one made of hard right angles.
function roundCorners(g: WalkGrid, px: [number, number][], cellSize: number): [number, number][] {
  if (px.length <= 2) return px;
  const out: [number, number][] = [px[0]];
  for (let i = 1; i < px.length - 1; i++) {
    const [ax, ay] = px[i - 1];
    const [bx, by] = px[i];
    const [cx, cy] = px[i + 1];
    const inLen = Math.hypot(bx - ax, by - ay);
    const outLen = Math.hypot(cx - bx, cy - by);
    // cut at most a third of each leg, and never more than ~1.5 cells' worth
    const cut = Math.min(inLen / 3, outLen / 3, cellSize * 2.5);
    if (cut < cellSize * 0.5) {
      out.push(px[i]);
      continue;
    }
    const p1: [number, number] = [bx + ((ax - bx) / inLen) * cut, by + ((ay - by) / inLen) * cut];
    const p2: [number, number] = [bx + ((cx - bx) / outLen) * cut, by + ((cy - by) / outLen) * cut];
    const cell = (p: [number, number]): [number, number] => [
      Math.floor(p[0] / cellSize),
      Math.floor(p[1] / cellSize),
    ];
    if (hasLineOfSight(g, cell(p1), cell(p2))) {
      out.push(p1, p2);
    } else {
      out.push(px[i]);
    }
  }
  out.push(px[px.length - 1]);
  return out;
}

function cellToPx(g: WalkGrid, c: number, r: number): [number, number] {
  return [c * g.cellSize + g.cellSize / 2, r * g.cellSize + g.cellSize / 2];
}

/**
 * Wall-aware path between two pixel-space points on one floor. Falls back to a
 * straight line if the grid has no route between them (e.g. the two points
 * genuinely aren't connected by any edge yet) so the UI still shows something
 * rather than silently dropping the leg.
 */
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
  const pxPath = simplify(g, cellPath).map(([c, r]) => cellToPx(g, c, r));
  const smoothed = roundCorners(g, pxPath, g.cellSize);
  return [startXY, ...smoothed, endXY];
}

/** Total length of a pixel-space polyline. */
export function pathLengthPx(path: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  }
  return total;
}
