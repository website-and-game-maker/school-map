// One search index shared by both the "from" and "to" boxes: every room,
// entrance, landmark (Library, Cafeteria, Band Hall…) and marked restroom,
// across all three floors.

import type { FloorData, FloorId } from "../types";

export type SearchKind = "room" | "entrance" | "landmark" | "restroom" | "nearest-restroom";

export interface SearchItem {
  key: string; // unique across floors
  id: string; // graph point id on that floor
  floor: FloorId;
  label: string;
  kind: SearchKind;
}

const FLOOR_ORDER: FloorId[] = ["lower", "main", "upper"];

export function buildSearchIndex(floors: Record<FloorId, FloorData>): SearchItem[] {
  const items: SearchItem[] = [];
  const seenEntrance = new Set<string>();

  for (const f of FLOOR_ORDER) {
    for (const [id, p] of Object.entries(floors[f].points)) {
      if (p.kind === "room") {
        items.push({ key: `${f}:${id}`, id, floor: f, label: id, kind: "room" });
      } else if (p.kind === "entrance") {
        // An entrance letter shows up on several floors; list it once — the
        // router works out which floor's copy is actually closest.
        const name = p.label ?? id;
        if (seenEntrance.has(name)) continue;
        seenEntrance.add(name);
        items.push({ key: `entrance:${name}`, id, floor: f, label: name, kind: "entrance" });
      } else if (p.kind === "landmark") {
        items.push({ key: `${f}:${id}`, id, floor: f, label: p.label ?? id, kind: "landmark" });
      } else if (p.kind === "poi" && p.poiType === "restroom") {
        items.push({ key: `${f}:${id}`, id, floor: f, label: p.label ?? "Restroom", kind: "restroom" });
      }
    }
  }
  return items;
}

const RESTROOM_WORDS = ["restroom", "restrooms", "bathroom", "bathrooms", "toilet", "washroom", "wc"];

export const NEAREST_RESTROOM: SearchItem = {
  key: "__nearest_restroom__",
  id: "__nearest_restroom__",
  floor: "main",
  label: "Nearest restroom",
  kind: "nearest-restroom",
};

/**
 * Rank matches so that typing "24" surfaces room 245 before "Room 124", and
 * typing "libr" finds the Library. Restroom words map to the special
 * "nearest restroom" entry, which routes to whichever marked restroom is
 * actually closest.
 */
export function searchItems(
  items: SearchItem[],
  rawQuery: string,
  opts: { hasRestrooms: boolean; limit?: number } = { hasRestrooms: false }
): SearchItem[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [];

  const results: SearchItem[] = [];
  if (opts.hasRestrooms && RESTROOM_WORDS.some((w) => w.startsWith(q))) {
    results.push(NEAREST_RESTROOM);
  }

  const scored = items
    .map((item) => {
      const label = item.label.toLowerCase();
      let score = -1;
      if (label === q) score = 0;
      else if (label.startsWith(q)) score = 1;
      else if (label.includes(q)) score = 2;
      // let "room 245" and "245" both work
      else if (`room ${label}`.startsWith(q)) score = 2;
      return { item, score };
    })
    .filter((s) => s.score >= 0)
    .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label, undefined, { numeric: true }));

  for (const s of scored) results.push(s.item);
  return results.slice(0, opts.limit ?? 8);
}
