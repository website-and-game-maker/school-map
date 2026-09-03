// Simple Dijkstra shortest-path over the hallway graph.
// Nodes are named points (corridor junctions, entrances, and rooms).
// Edges are undirected, weighted by pixel distance (a stand-in for walking distance).

export type NodeId = string;
export type Point = [number, number];

export interface GraphData {
  image: { w: number; h: number };
  rooms: Record<NodeId, Point>;
  landmarks: Record<NodeId, Point>;
  nodes: Record<NodeId, Point>;
  corridorEdges: { from: NodeId; to: NodeId; w: number }[];
  roomEdges: { from: NodeId; to: NodeId; w: number }[];
  entrances: NodeId[];
}

interface AdjEntry {
  to: NodeId;
  w: number;
}

export function buildAdjacency(data: GraphData): Map<NodeId, AdjEntry[]> {
  const adj = new Map<NodeId, AdjEntry[]>();
  const addEdge = (a: NodeId, b: NodeId, w: number) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ to: b, w });
    adj.get(b)!.push({ to: a, w });
  };
  for (const e of data.corridorEdges) addEdge(e.from, e.to, e.w);
  for (const e of data.roomEdges) addEdge(e.from, e.to, e.w);
  return adj;
}

export function shortestPath(
  adj: Map<NodeId, AdjEntry[]>,
  start: NodeId,
  end: NodeId
): NodeId[] | null {
  const dist = new Map<NodeId, number>();
  const prev = new Map<NodeId, NodeId>();
  const visited = new Set<NodeId>();
  dist.set(start, 0);

  // simple O(V^2) Dijkstra — graph is small (~130 nodes), no need for a heap
  while (true) {
    let u: NodeId | null = null;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < best) {
        best = d;
        u = node;
      }
    }
    if (u === null) break;
    if (u === end) break;
    visited.add(u);
    for (const { to, w } of adj.get(u) ?? []) {
      const nd = best + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, u);
      }
    }
  }

  if (!dist.has(end)) return null;
  const path: NodeId[] = [end];
  let cur = end;
  while (cur !== start) {
    const p = prev.get(cur);
    if (!p) return null;
    path.push(p);
    cur = p;
  }
  path.reverse();
  return path;
}
