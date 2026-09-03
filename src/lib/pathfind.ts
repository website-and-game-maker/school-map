// Dijkstra over a graph that spans all three floors. Each floor is its own
// small graph of points+edges (see types.ts); "stairs" links stitch matching
// points on adjacent floors together so a route can cross levels.
//
// Nodes in the combined graph are keyed "<floorId>::<pointId>" so the same
// point id (e.g. "Entrance A") can exist independently on multiple floors.

import type { FloorData, FloorId, StairLink } from "../types";

export type NodeKey = string; // `${FloorId}::${pointId}`

const STAIR_WEIGHT = 260; // stand-in "cost" for a flight of stairs, in the same
// rough units as pixel-distance on a single floor's image.

export function nodeKey(floor: FloorId, pointId: string): NodeKey {
  return `${floor}::${pointId}`;
}

export function splitKey(key: NodeKey): { floor: FloorId; pointId: string } {
  const idx = key.indexOf("::");
  return { floor: key.slice(0, idx) as FloorId, pointId: key.slice(idx + 2) };
}

interface AdjEntry {
  to: NodeKey;
  w: number;
  via?: { kind: "stairs" | "elevator"; verified: boolean };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function buildAdjacency(
  floors: Record<FloorId, FloorData>,
  stairs: StairLink[]
): Map<NodeKey, AdjEntry[]> {
  const adj = new Map<NodeKey, AdjEntry[]>();
  const addEdge = (a: NodeKey, b: NodeKey, w: number, via?: AdjEntry["via"]) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ to: b, w, via });
    adj.get(b)!.push({ to: a, w, via });
  };

  for (const floor of Object.values(floors)) {
    for (const e of floor.edges) {
      const pa = floor.points[e.a];
      const pb = floor.points[e.b];
      if (!pa || !pb) continue;
      addEdge(nodeKey(floor.id, e.a), nodeKey(floor.id, e.b), dist(pa, pb));
    }
  }

  for (const link of stairs) {
    const entries = Object.entries(link.points) as [FloorId, string][];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [fa, pa] = entries[i];
        const [fb, pb] = entries[j];
        if (!floors[fa]?.points[pa] || !floors[fb]?.points[pb]) continue;
        addEdge(nodeKey(fa, pa), nodeKey(fb, pb), STAIR_WEIGHT, {
          kind: link.kind,
          verified: link.verified,
        });
      }
    }
  }

  return adj;
}

interface PathResult {
  path: NodeKey[];
  usedStairs: { kind: string; verified: boolean }[];
}

// Supports multiple candidate start/end nodes (e.g. "Entrance A" exists on
// several floors, or several restrooms have been marked) by wiring them to a
// zero-weight virtual node and running one Dijkstra pass.
export function shortestPathMulti(
  adj: Map<NodeKey, AdjEntry[]>,
  starts: NodeKey[],
  ends: NodeKey[]
): PathResult | null {
  const VSTART = "__start__";
  const VEND = "__end__";
  const extra = new Map<NodeKey, AdjEntry[]>();
  const get = (k: NodeKey) => {
    if (!extra.has(k)) extra.set(k, [...(adj.get(k) ?? [])]);
    return extra.get(k)!;
  };
  for (const s of starts) get(VSTART).push({ to: s, w: 0 });
  // Edges must point *into* VEND (traversal runs forward from VSTART), so
  // each end node gets a one-way edge to VEND — not the other way around.
  for (const e of ends) get(e).push({ to: VEND, w: 0 });
  // also copy neighbor lists so we don't mutate the shared adjacency
  const combined = (k: NodeKey): AdjEntry[] => extra.get(k) ?? adj.get(k) ?? [];

  const dist = new Map<NodeKey, number>();
  const prev = new Map<NodeKey, NodeKey>();
  const viaEdge = new Map<NodeKey, AdjEntry["via"]>();
  const visited = new Set<NodeKey>();
  dist.set(VSTART, 0);

  while (true) {
    let u: NodeKey | null = null;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < best) {
        best = d;
        u = node;
      }
    }
    if (u === null) break;
    if (u === VEND) break;
    visited.add(u);
    for (const { to, w, via } of combined(u)) {
      const nd = best + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, u);
        if (via) viaEdge.set(to, via);
      }
    }
  }

  if (!dist.has(VEND)) return null;
  const full: NodeKey[] = [VEND];
  let cur = VEND;
  const stairsUsed: AdjEntry["via"][] = [];
  while (cur !== VSTART) {
    const via = viaEdge.get(cur);
    if (via) stairsUsed.push(via);
    const p = prev.get(cur);
    if (!p) return null;
    full.push(p);
    cur = p;
  }
  full.reverse();
  // trim the virtual start/end nodes
  const path = full.filter((k) => k !== VSTART && k !== VEND);
  stairsUsed.reverse();
  return {
    path,
    usedStairs: stairsUsed.filter((v): v is NonNullable<typeof v> => !!v),
  };
}

export interface FloorSegment {
  floor: FloorId;
  points: string[];
}

export function splitByFloor(path: NodeKey[]): FloorSegment[] {
  const segments: FloorSegment[] = [];
  for (const key of path) {
    const { floor, pointId } = splitKey(key);
    const last = segments[segments.length - 1];
    if (last && last.floor === floor) {
      last.points.push(pointId);
    } else {
      segments.push({ floor, points: [pointId] });
    }
  }
  return segments;
}
