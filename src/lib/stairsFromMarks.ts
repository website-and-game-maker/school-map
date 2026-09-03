// Stair links built from markers the user drops in Edit mode.
//
// Automated detection of stairwells on these scans doesn't work — the treads
// blur together at this resolution and the symbols that survive look exactly
// like room-number text. So the app takes the honest route: you mark a
// stairwell on each floor it serves, and matching markers across floors get
// linked automatically using the floor alignment.

import { applyTransform, buildTransforms } from "./floorAlign";
import type { FloorData, FloorId, StairLink } from "../types";

const MATCH_PX = 130; // how close two markers must land to be the same stairwell

export const STAIR_POI = "stairs";

export function stairMarks(floors: Record<FloorId, FloorData>) {
  const out: { floor: FloorId; id: string; x: number; y: number }[] = [];
  for (const f of ["lower", "main", "upper"] as FloorId[]) {
    for (const [id, p] of Object.entries(floors[f].points)) {
      if (p.kind === "poi" && p.poiType === STAIR_POI) out.push({ floor: f, id, x: p.x, y: p.y });
    }
  }
  return out;
}

/** Group markers that land in the same place once floors are aligned. */
export function linksFromMarks(floors: Record<FloorId, FloorData>): StairLink[] {
  const marks = stairMarks(floors);
  if (marks.length < 2) return [];
  const T = buildTransforms(floors);
  const inMain = marks.map((m) => {
    if (m.floor === "main") return { m, at: [m.x, m.y] as [number, number] };
    const t = T[`${m.floor}->main`];
    return { m, at: t ? applyTransform(t, m.x, m.y) : ([m.x, m.y] as [number, number]) };
  });

  const groups: { at: [number, number]; marks: typeof marks }[] = [];
  for (const { m, at } of inMain) {
    const hit = groups.find((g) => Math.hypot(g.at[0] - at[0], g.at[1] - at[1]) < MATCH_PX);
    if (hit) {
      if (!hit.marks.some((x) => x.floor === m.floor)) hit.marks.push(m);
    } else {
      groups.push({ at, marks: [m] });
    }
  }

  return groups
    .filter((g) => g.marks.length >= 2)
    .map((g, i) => ({
      id: `stairs-marked-${i}`,
      kind: "stairs" as const,
      verified: true,
      points: Object.fromEntries(g.marks.map((m) => [m.floor, m.id])) as StairLink["points"],
    }));
}
