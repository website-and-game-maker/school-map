// Every landmark on the source plan (Library, Cafeteria, Commons, Band Hall,
// the Auditorium…) was traced as a point but never wired into the hallway
// graph — which meant searching for exactly the places a lost freshman
// actually asks for returned "no route".
//
// Rather than hand-drawing 34 more edges, this attaches any point with no
// edges at all to the nearest point that *is* connected, as long as that's
// close enough to be plausible. The links are flagged `auto` so Edit mode can
// draw them dashed and you can replace any that take a silly line.

import type { FloorData, FloorEdge } from "../types";

// Past this, an auto-link stops being "this landmark opens onto that hallway"
// and starts being a guess across the campus. ~560 px ≈ 215 ft, which is far
// enough to reach the Performing Arts wing (no corridors traced there yet) but
// not so far that outdoor points like the stadium get pulled into the building.
const MAX_LINK_PX = 560;

export function withAutoLinks(floor: FloorData): FloorData {
  const connected = new Set<string>();
  for (const e of floor.edges) {
    connected.add(e.a);
    connected.add(e.b);
  }

  const isolated = Object.keys(floor.points).filter((id) => !connected.has(id));
  if (isolated.length === 0) return floor;

  const added: FloorEdge[] = [];
  for (const id of isolated) {
    const p = floor.points[id];
    let best: { id: string; d: number } | null = null;
    for (const other of connected) {
      const q = floor.points[other];
      if (!q) continue;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (!best || d < best.d) best = { id: other, d };
    }
    if (best && best.d <= MAX_LINK_PX) added.push({ a: id, b: best.id, auto: true });
  }

  if (added.length === 0) return floor;
  return { ...floor, edges: [...floor.edges, ...added] };
}
