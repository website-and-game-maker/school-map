// The pile of things the scan reader was not sure enough about to act on.
//
// `tools/read_plan.py` reads every room number off the plan and applies the
// reads it is confident in — measured threshold 0.5, above which no read has
// turned out to be wrong and below which several have. What it will not do is
// guess. So a handful of rooms per floor end up in neither state: the reader
// saw something, it fits the room-number grammar, but it scored 0.25 and could
// equally be a 5 that is really a 6.
//
// Those are worth a human's ten seconds each, and they are exactly the kind of
// thing that never gets done if it lives in a JSON file in a tools directory.
// So they come into the app instead. Each one is a place on the map you can
// jump to, look at, and accept or ignore.
//
// This ships only numbers and coordinates — nothing derived from the page
// pixels — which is why it is allowed to live under src/ when the scans
// themselves are not.

import type { FloorData, FloorId } from "../types";
import scanReport from "../data/floors/scan-report.json";

interface RawFloorReport {
  corrected: { was: string[]; text: string; x: number; y: number; conf: number }[];
  found: { text: string; x: number; y: number; conf: number }[];
  unread: { label: string; x: number; y: number }[];
  confirmed: number;
}

const REPORT = scanReport as unknown as Record<FloorId, RawFloorReport>;

/** Matches MIN_APPLY_CONF in tools/read_plan.py. Anything at or above this is
 *  already in the shipped data, so it is never a suggestion. */
export const APPLIED_CONF = 0.5;

export interface ScanSuggestion {
  /** The number the scan thinks is printed here. */
  text: string;
  x: number;
  y: number;
  conf: number;
  /** What the shipped data used to call this spot, when it disagreed. */
  was?: string[];
}

export interface ScanReview {
  /** Reads too weak to apply, for rooms the floor does not currently have. */
  suggestions: ScanSuggestion[];
  /**
   * Rooms the previous data had that are gone: the scan read a DIFFERENT number
   * in the pocket they sat in, so they were removed rather than left pointing
   * at the wrong door. These are the ones most worth a human's attention.
   */
  missing: string[];
  confirmed: number;
}

/**
 * What still needs looking at on this floor, given what the floor now holds.
 *
 * Recomputed against live floor data rather than baked into the report, so a
 * suggestion disappears the moment the editor accepts it — including when they
 * place the room by hand instead.
 */
export function reviewFor(floorId: FloorId, floor: FloorData): ScanReview {
  const r = REPORT[floorId];
  if (!r) return { suggestions: [], missing: [], confirmed: 0 };

  const have = new Set(
    Object.entries(floor.points)
      .filter(([, p]) => p.kind === "room")
      .map(([id]) => id)
  );

  const seen = new Set<string>();
  const suggestions: ScanSuggestion[] = [];
  const consider = (s: ScanSuggestion) => {
    if (s.conf >= APPLIED_CONF) return; // already in the data
    if (have.has(s.text) || seen.has(s.text)) return;
    seen.add(s.text);
    suggestions.push(s);
  };
  for (const c of r.corrected) consider({ text: c.text, x: c.x, y: c.y, conf: c.conf, was: c.was });
  for (const f of r.found) consider({ text: f.text, x: f.x, y: f.y, conf: f.conf });
  suggestions.sort((a, b) => b.conf - a.conf || a.text.localeCompare(b.text, undefined, { numeric: true }));

  // A room named in the report that the floor no longer has, and that no
  // suggestion would restore, is simply missing.
  const named = new Set<string>();
  for (const c of r.corrected) for (const w of c.was) named.add(w);
  for (const u of r.unread) named.add(u.label);
  const missing = [...named]
    .filter((n) => !have.has(n) && !seen.has(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return { suggestions, missing, confirmed: r.confirmed };
}
