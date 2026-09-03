// Routing over real walkable space.
//
// Earlier versions routed over the hand-traced point graph and then drew a
// line, which meant the route was only as good — and only as *short* — as the
// handful of points someone had traced. This routes over the floor plan
// itself: a Dijkstra across the walkable grid, where a step is legal only if
// there's no ink between the two cells, hallways are cheap, and the inside of
// a classroom is expensive (so a route enters one only to arrive).
//
// Floors are joined by stair links, and the whole thing is solved as one
// search, so a route uses whichever staircase actually gets you there fastest
// rather than whichever one happens to be nearest the entrance.

import { centreOf, navGrids, snap, type NavGrid } from "./nav";
import type { FloorData, FloorId, StairLink } from "../types";

const ROOM_COST = 3.2; // walking through a classroom vs down the hall
const WALL_COST = 1.5; // hugging a wall vs the middle of the corridor
const STAIR_COST_FT = 220; // a flight, in equivalent feet of walking — high enough that a
// route only changes floor when it genuinely saves a walk, not to shave a corner

export interface RouteLegCells {
  floor: FloorId;
  cells: number[];
}

export interface GridRoute {
  legs: { floor: FloorId; path: [number, number][] }[];
  stairs: { from: FloorId; to: FloorId; verified: boolean }[];
  costFeet: number;
  startFloor: FloorId;
  endFloor: FloorId;
  endPoint: [number, number];
  startPoint: [number, number];
}

function enterCost(g: NavGrid, i: number): number {
  const base = g.pub[i] === 1 ? 1 : ROOM_COST;
  return g.clearance[i] < 2 ? base * WALL_COST : base;
}

interface Heap {
  push(cell: number, dist: number): void;
  pop(): { cell: number; dist: number } | undefined;
  size: number;
}

function makeHeap(): Heap {
  const cells: number[] = [];
  const dists: number[] = [];
  return {
    get size() {
      return cells.length;
    },
    push(cell, dist) {
      cells.push(cell);
      dists.push(dist);
      let i = cells.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (dists[p] <= dists[i]) break;
        [cells[p], cells[i]] = [cells[i], cells[p]];
        [dists[p], dists[i]] = [dists[i], dists[p]];
        i = p;
      }
    },
    pop() {
      if (cells.length === 0) return undefined;
      const cell = cells[0];
      const dist = dists[0];
      const lc = cells.pop()!;
      const ld = dists.pop()!;
      if (cells.length) {
        cells[0] = lc;
        dists[0] = ld;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let s = i;
          if (l < cells.length && dists[l] < dists[s]) s = l;
          if (r < cells.length && dists[r] < dists[s]) s = r;
          if (s === i) break;
          [cells[s], cells[i]] = [cells[i], cells[s]];
          [dists[s], dists[i]] = [dists[i], dists[s]];
          i = s;
        }
      }
      return { cell, dist };
    },
  };
}

export interface Field {
  // Float64, deliberately: costs are computed as doubles, and rounding them to
  // float32 on the way in makes the "have I already got here cheaper?" check
  // reject its own freshly-written value, which silently truncates the search.
  dist: Float64Array;
  prev: Int32Array;
}

/**
 * Cost from a set of source cells to every reachable cell on one floor.
 * Step legality comes from the east/south planes, so walls hold.
 */
export function distanceField(g: NavGrid, sources: number[]): Field {
  const n = g.cols * g.rows;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = makeHeap();
  for (const s of sources) {
    if (s >= 0 && s < n && g.walk[s]) {
      dist[s] = 0;
      heap.push(s, 0);
    }
  }
  const SQRT2 = Math.SQRT2;
  while (heap.size) {
    const top = heap.pop()!;
    const i = top.cell;
    if (top.dist > dist[i]) continue;
    const r = (i / g.cols) | 0;
    const c = i - r * g.cols;

    // legality of the four cardinal steps, from the exported planes
    const canE = c + 1 < g.cols && g.east[i] === 1;
    const canW = c > 0 && g.east[i - 1] === 1;
    const canS = r + 1 < g.rows && g.south[i] === 1;
    const canN = r > 0 && g.south[i - g.cols] === 1;

    const relax = (j: number, step: number) => {
      const nd = top.dist + step * 0.5 * (enterCost(g, i) + enterCost(g, j));
      if (nd < dist[j]) {
        dist[j] = nd;
        prev[j] = i;
        heap.push(j, nd);
      }
    };

    if (canE) relax(i + 1, 1);
    if (canW) relax(i - 1, 1);
    if (canS) relax(i + g.cols, 1);
    if (canN) relax(i - g.cols, 1);
    // diagonals only where both orthogonal steps are legal — no slipping
    // through the corner where two walls meet
    if (canE && canS && g.south[i + 1] === 1 && g.east[i + g.cols] === 1) relax(i + g.cols + 1, SQRT2);
    if (canW && canS && g.south[i - 1] === 1 && g.east[i + g.cols - 1] === 1) relax(i + g.cols - 1, SQRT2);
    if (canE && canN && g.south[i - g.cols] === 1 && g.east[i - g.cols] === 1) relax(i - g.cols + 1, SQRT2);
    if (canW && canN && g.south[i - g.cols - 1] === 1 && g.east[i - g.cols - 1] === 1)
      relax(i - g.cols - 1, SQRT2);
  }
  return { dist, prev };
}

function tracePath(field: Field, target: number): number[] {
  const out: number[] = [];
  let cur = target;
  let guard = 0;
  while (cur >= 0 && guard++ < 500000) {
    out.push(cur);
    cur = field.prev[cur];
  }
  return out.reverse();
}

// ---------------------------------------------------------------- geometry

function lineClear(g: NavGrid, a: number, b: number): boolean {
  const ar = (a / g.cols) | 0;
  const ac = a - ar * g.cols;
  const br = (b / g.cols) | 0;
  const bc = b - br * g.cols;
  let x = ac;
  let y = ar;
  const dx = Math.abs(bc - ac);
  const dy = -Math.abs(br - ar);
  const sx = ac < bc ? 1 : -1;
  const sy = ar < br ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    const i = y * g.cols + x;
    if (!g.walk[i]) return false;
    if (x === bc && y === br) return true;
    const e2 = 2 * err;
    const stepX = e2 >= dy;
    const stepY = e2 <= dx;
    if (stepX) {
      if (sx > 0 ? g.east[i] !== 1 : g.east[i - 1] !== 1) return false;
      err += dy;
      x += sx;
    }
    if (stepY) {
      const j = y * g.cols + x;
      if (sy > 0 ? g.south[j] !== 1 : g.south[j - g.cols] !== 1) return false;
      err += dx;
      y += sy;
    }
  }
}

/** Drop cells that lie on a straight walkable run, keeping the shape. */
function simplify(g: NavGrid, cells: number[]): number[] {
  if (cells.length <= 2) return cells;
  const out = [cells[0]];
  let anchor = 0;
  for (let i = 2; i < cells.length; i++) {
    if (!lineClear(g, cells[anchor], cells[i])) {
      out.push(cells[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(cells[cells.length - 1]);
  return out;
}

/** Soften the corners so the line reads as a walk, not a staircase of cells. */
function roundCorners(pts: [number, number][], maxCut: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const [cx, cy] = pts[i + 1];
    const inLen = Math.hypot(bx - ax, by - ay);
    const outLen = Math.hypot(cx - bx, cy - by);
    const cut = Math.min(inLen / 3, outLen / 3, maxCut);
    if (cut < 2) {
      out.push(pts[i]);
      continue;
    }
    out.push([bx + ((ax - bx) / inLen) * cut, by + ((ay - by) / inLen) * cut]);
    out.push([bx + ((cx - bx) / outLen) * cut, by + ((cy - by) / outLen) * cut]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function toPolyline(g: NavGrid, cells: number[]): [number, number][] {
  return roundCorners(
    simplify(g, cells).map((c) => centreOf(g, c)),
    g.cell * 2.5
  );
}

// ---------------------------------------------------------------- routing

export interface Endpoint {
  floor: FloorId;
  x: number;
  y: number;
}

interface StairEnd {
  linkId: string;
  floor: FloorId;
  cell: number;
  verified: boolean;
  kind: "stairs" | "elevator";
}

const fieldCache = new Map<string, Field>();

export function clearRouteCache() {
  fieldCache.clear();
}

function fieldFrom(grids: Record<FloorId, NavGrid>, floor: FloorId, cells: number[], key?: string): Field {
  if (key) {
    const hit = fieldCache.get(key);
    if (hit) return hit;
  }
  const f = distanceField(grids[floor], cells);
  if (key) fieldCache.set(key, f);
  return f;
}

function stairEnds(floors: Record<FloorId, FloorData>, grids: Record<FloorId, NavGrid>, stairs: StairLink[]) {
  const ends: StairEnd[] = [];
  for (const link of stairs) {
    for (const [floor, pointId] of Object.entries(link.points) as [FloorId, string][]) {
      const p = floors[floor]?.points[pointId];
      if (!p) continue;
      const cell = snap(grids[floor], p.x, p.y, true) ?? snap(grids[floor], p.x, p.y);
      if (cell == null) continue;
      ends.push({ linkId: link.id, floor, cell, verified: link.verified, kind: link.kind });
    }
  }
  return ends;
}

/**
 * Fastest walk between any two points, across floors. Endpoints may each have
 * several candidates (an entrance exists on every floor; "nearest restroom" is
 * whichever one is actually closest) — they all seed the same search, so the
 * winner falls out of the cost rather than being picked in advance.
 */
export function route(
  floors: Record<FloorId, FloorData>,
  stairs: StairLink[],
  starts: Endpoint[],
  ends: Endpoint[],
  pxPerFoot: number
): GridRoute | null {
  const grids = navGrids();
  if (starts.length === 0 || ends.length === 0) return null;

  const stairCostCells = (STAIR_COST_FT * pxPerFoot) / grids.main.cell;

  const snapEndpoint = (e: Endpoint) => {
    const g = grids[e.floor];
    const cell = snap(g, e.x, e.y) ?? null;
    return cell == null ? null : { ...e, cell };
  };
  const S = starts.map(snapEndpoint).filter(Boolean) as (Endpoint & { cell: number })[];
  const E = ends.map(snapEndpoint).filter(Boolean) as (Endpoint & { cell: number })[];
  if (S.length === 0 || E.length === 0) return null;

  const ends2 = stairEnds(floors, grids, stairs);

  // distance fields out of the start(s), per floor they occupy
  const startFields = new Map<FloorId, Field>();
  for (const f of new Set(S.map((s) => s.floor))) {
    startFields.set(f, fieldFrom(grids, f, S.filter((s) => s.floor === f).map((s) => s.cell)));
  }
  // and, cached, out of every stair landing
  const stairFields = new Map<string, Field>();
  for (const se of ends2) {
    const key = `${se.floor}:${se.cell}`;
    stairFields.set(key, fieldFrom(grids, se.floor, [se.cell], key));
  }

  // Small graph over {start} ∪ stair landings ∪ {end}. Every edge that means
  // "walk" records which floor it happens on and which distance field measures
  // it, so rebuilding the actual path afterwards is unambiguous — picking the
  // wrong start candidate here is what made routes teleport between floors.
  type Node = string;
  const NODE_START: Node = "@start";
  const NODE_END: Node = "@end";

  type FieldKey = { kind: "start"; floor: FloorId } | { kind: "stair"; floor: FloorId; cell: number };
  interface Edge {
    to: Node;
    w: number;
    walk?: { floor: FloorId; cell: number; field: FieldKey };
    stair?: { from: FloorId; to: FloorId; verified: boolean };
  }

  const adj = new Map<Node, Edge[]>();
  const add = (a: Node, e: Edge) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(e);
  };

  const seNodes = ends2.map((se, i) => ({ se, node: `${se.linkId}#${i}` }));
  const getField = (k: FieldKey): Field | undefined =>
    k.kind === "start" ? startFields.get(k.floor) : stairFields.get(`${k.floor}:${k.cell}`);

  // straight there, no stairs
  for (const e of E) {
    const sf = startFields.get(e.floor);
    if (sf && Number.isFinite(sf.dist[e.cell])) {
      add(NODE_START, {
        to: NODE_END,
        w: sf.dist[e.cell],
        walk: { floor: e.floor, cell: e.cell, field: { kind: "start", floor: e.floor } },
      });
    }
  }

  for (const { se, node } of seNodes) {
    const sf = startFields.get(se.floor);
    if (sf && Number.isFinite(sf.dist[se.cell])) {
      add(NODE_START, {
        to: node,
        w: sf.dist[se.cell],
        walk: { floor: se.floor, cell: se.cell, field: { kind: "start", floor: se.floor } },
      });
    }
    const key: FieldKey = { kind: "stair", floor: se.floor, cell: se.cell };
    const field = stairFields.get(`${se.floor}:${se.cell}`)!;
    for (const e of E) {
      if (e.floor === se.floor && Number.isFinite(field.dist[e.cell])) {
        add(node, { to: NODE_END, w: field.dist[e.cell], walk: { floor: e.floor, cell: e.cell, field: key } });
      }
    }
    for (const other of seNodes) {
      if (other.node === node) continue;
      if (other.se.linkId === se.linkId) {
        add(node, {
          to: other.node,
          w: stairCostCells,
          stair: { from: se.floor, to: other.se.floor, verified: se.verified },
        });
      } else if (other.se.floor === se.floor && Number.isFinite(field.dist[other.se.cell])) {
        add(node, {
          to: other.node,
          w: field.dist[other.se.cell],
          walk: { floor: other.se.floor, cell: other.se.cell, field: key },
        });
      }
    }
  }

  // Dijkstra over that small graph
  const dist = new Map<Node, number>([[NODE_START, 0]]);
  const prev = new Map<Node, { node: Node; edge: Edge }>();
  const seen = new Set<Node>();
  for (;;) {
    let best: Node | null = null;
    let bd = Infinity;
    for (const [n, d] of dist) {
      if (!seen.has(n) && d < bd) {
        bd = d;
        best = n;
      }
    }
    if (best == null || best === NODE_END) break;
    seen.add(best);
    for (const edge of adj.get(best) ?? []) {
      const nd = bd + edge.w;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, { node: best, edge });
      }
    }
  }
  if (!dist.has(NODE_END)) return null;

  // Replay the winning chain, drawing each walk with the field that measured it.
  const chain: Edge[] = [];
  let cur: Node = NODE_END;
  while (cur !== NODE_START) {
    const step = prev.get(cur);
    if (!step) return null;
    chain.push(step.edge);
    cur = step.node;
  }
  chain.reverse();

  const legs: GridRoute["legs"] = [];
  const stairsUsed: GridRoute["stairs"] = [];
  let startPt: [number, number] | null = null;
  let endPt: [number, number] | null = null;
  let endFloorId: FloorId = ends[0].floor;

  for (const edge of chain) {
    if (edge.stair) {
      stairsUsed.push(edge.stair);
      continue;
    }
    if (!edge.walk) continue;
    const field = getField(edge.walk.field);
    const g = grids[edge.walk.floor];
    if (!field) continue;
    const cells = tracePath(field, edge.walk.cell);
    if (cells.length === 0) continue;
    legs.push({ floor: edge.walk.floor, path: toPolyline(g, cells) });
    if (startPt === null) {
      // the traced path ends at whichever start candidate was actually nearest
      const first = S.find((s) => s.floor === edge.walk!.floor && s.cell === cells[0]);
      const c0 = centreOf(g, cells[0]);
      startPt = first ? [first.x, first.y] : c0;
    }
    endFloorId = edge.walk.floor;
    const last = E.find((e) => e.floor === edge.walk!.floor && e.cell === edge.walk!.cell);
    endPt = last ? [last.x, last.y] : centreOf(g, edge.walk.cell);
  }

  if (legs.length && startPt) legs[0].path = [startPt, ...legs[0].path];
  if (legs.length && endPt) legs[legs.length - 1].path = [...legs[legs.length - 1].path, endPt];

  const kept = legs.filter((l) => l.path.length > 1);
  if (kept.length === 0) return null;
  return {
    legs: kept,
    stairs: stairsUsed,
    costFeet: (dist.get(NODE_END)! * grids.main.cell) / pxPerFoot,
    startFloor: kept[0].floor,
    endFloor: endFloorId,
    startPoint: startPt ?? kept[0].path[0],
    endPoint: endPt ?? kept[kept.length - 1].path[kept[kept.length - 1].path.length - 1],
  };
}
