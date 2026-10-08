// A student's day as a list of rooms, and the walks between them.
//
// The tour map's second page is a hand-drawn version of exactly this: your
// classes in order, and the way from each to the next. Someone who already
// knows the building will never search "245", but they will want to know
// whether 118 → 312 is makeable in a passing period.
//
// Everything routing-related is borrowed, not reimplemented: the room is
// resolved through the same search index the From/To boxes use, the walk is
// whatever route() returns for those two items, and the time is the one
// buildDirections() quotes — so a transition's "4 min" is the same number the
// directions say when you click it.

import { buildDirections, type Directions } from "./directions";
import type { GridRoute } from "./router";
import type { SearchItem } from "./search";

/**
 * How long a walk can take before it is flagged as tight. Seven minutes is a
 * common US passing period; the estimate is already on the slow side (see
 * FEET_PER_SECOND in directions.ts), so a flag means "genuinely far", not
 * "far if you dawdle".
 */
export const PASSING_PERIOD_MINUTES = 7;

/** Room count a fresh schedule offers; most days have between four and eight. */
export const DEFAULT_PERIODS = 4;

export interface ScheduleEntry {
  /** What the student calls it: "Period 1", "A1", "Chem". Free text. */
  name: string;
  /** What they typed for the room, kept even when it matches nothing. */
  room: string;
  /**
   * The search item they picked, by key. Stored so a pick survives a reload
   * without re-guessing; the typed text is the fallback if the key ever stops
   * existing (a room renumbered in the data, say).
   */
  key: string | null;
}

export interface Schedule {
  periods: ScheduleEntry[];
  /** Where the day starts. Null means "no arrival walk, start at period 1". */
  arriveFrom: { label: string; key: string | null } | null;
}

const STORAGE_KEY = "westlake-map:schedule:v1";

export function emptySchedule(arriveFrom: Schedule["arriveFrom"]): Schedule {
  return {
    periods: Array.from({ length: DEFAULT_PERIODS }, (_, i) => ({
      name: `Period ${i + 1}`,
      room: "",
      key: null,
    })),
    arriveFrom,
  };
}

/**
 * Whatever is in storage, if it is shaped like a schedule. Anything else —
 * no storage at all (private window, blocked site data), a corrupt value, an
 * older format — reads as "no schedule yet", which the panel handles anyway.
 */
export function loadSchedule(): Schedule | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Schedule>;
    if (!Array.isArray(v.periods)) return null;
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    const periods = v.periods.map((p: Partial<ScheduleEntry>, i) => ({
      name: str(p?.name) || `Period ${i + 1}`,
      room: str(p?.room),
      key: typeof p?.key === "string" ? p.key : null,
    }));
    const a = v.arriveFrom;
    const arriveFrom =
      a && typeof a === "object" && typeof a.label === "string"
        ? { label: a.label, key: typeof a.key === "string" ? a.key : null }
        : null;
    return { periods, arriveFrom };
  } catch {
    return null;
  }
}

export function saveSchedule(s: Schedule | null): void {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not being able to save is survivable: the schedule still works for this
    // visit, it just has to be typed again next time.
  }
}

/**
 * Turn what was stored back into a place on the map. The picked key wins;
 * failing that, typed text that names exactly one thing — "245", "room 245",
 * "library" — counts as picking it, so typing a room number and moving on
 * does what it looks like it does. Anything vaguer stays unresolved and is
 * shown as such, rather than silently routed to a best guess.
 */
export function resolvePlace(index: SearchItem[], text: string, key: string | null): SearchItem | null {
  if (key) {
    const hit = index.find((i) => i.key === key);
    if (hit) return hit;
  }
  const q = text.trim().toLowerCase().replace(/^room\s+/, "");
  if (!q) return null;
  const exact = index.filter(
    (i) => i.label.toLowerCase() === q || (i.aliases ?? []).some((a) => a.toLowerCase() === q)
  );
  // A number can name a room and, as an alias, the gym that occupies it; the
  // room's own label is the better answer, same as the search ranks it.
  const byLabel = exact.filter((i) => i.label.toLowerCase() === q);
  if (byLabel.length === 1) return byLabel[0];
  return exact.length === 1 ? exact[0] : null;
}

/** "Room 245" for a numbered room, the name for anything else. */
export function placeLabel(item: SearchItem): string {
  return item.kind === "room" && /^\d/.test(item.label) ? `Room ${item.label}` : item.label;
}

export interface Transition {
  /** Stable for a given pair of places — what the route cache is keyed on. */
  id: string;
  fromName: string;
  toName: string;
  from: SearchItem | null;
  to: SearchItem | null;
  /** The room text as typed, for saying which end is not on the map. */
  fromText: string;
  toText: string;
}

/**
 * The day's walks, in order: the arrival (if any) into the first class, then
 * each class into the next. Periods with no room at all are skipped — a free
 * period is not a walk — but a room that was typed and not found is kept, so
 * it shows up as a problem instead of quietly vanishing from the day.
 */
export function transitionsFor(index: SearchItem[], s: Schedule): Transition[] {
  const stops: { name: string; text: string; item: SearchItem | null }[] = [];
  if (s.arriveFrom) {
    stops.push({
      name: "Arrive",
      text: s.arriveFrom.label,
      item: resolvePlace(index, s.arriveFrom.label, s.arriveFrom.key),
    });
  }
  for (const p of s.periods) {
    if (!p.room.trim()) continue;
    stops.push({ name: p.name.trim() || "Class", text: p.room, item: resolvePlace(index, p.room, p.key) });
  }
  const out: Transition[] = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    out.push({
      id: `${a.item?.key ?? `?${a.text}`}>${b.item?.key ?? `?${b.text}`}`,
      fromName: a.name,
      toName: b.name,
      from: a.item,
      to: b.item,
      fromText: a.text,
      toText: b.text,
    });
  }
  return out;
}

export type TransitionSummary =
  | { status: "ok"; minutes: number; feet: number; flights: number; tight: boolean }
  | { status: "same-room" }
  | { status: "unknown-room"; which: string[] }
  | { status: "no-route" };

/**
 * Time and distance for one walk, using the app's own router and its own
 * minutes estimate. `routeBetween` is the same computation the main route
 * display does for a From/To pair, passed in so there is exactly one place
 * that turns two search items into a route.
 */
export function summarize(
  t: Transition,
  routeBetween: (from: SearchItem, to: SearchItem) => GridRoute | null
): TransitionSummary {
  if (!t.from || !t.to) {
    const which = [!t.from ? t.fromText : null, !t.to ? t.toText : null].filter(Boolean) as string[];
    return { status: "unknown-room", which };
  }
  if (t.from.key === t.to.key) return { status: "same-room" };
  const r = routeBetween(t.from, t.to);
  if (!r || r.legs.length === 0) return { status: "no-route" };
  const d: Directions = buildDirections(r.legs, placeLabel(t.from), placeLabel(t.to));
  return {
    status: "ok",
    minutes: d.minutes,
    feet: d.totalFeet,
    flights: d.flights,
    tight: d.minutes > PASSING_PERIOD_MINUTES,
  };
}

/**
 * `summarize`, remembered per pair of places. Make one per `routeBetween`:
 * that function only changes when the map data does, so as long as it is the
 * same, renaming a period or reopening the list never routes anything twice.
 */
export function cachedSummarizer(
  routeBetween: (from: SearchItem, to: SearchItem) => GridRoute | null
): (t: Transition) => TransitionSummary {
  const seen = new Map<string, TransitionSummary>();
  return (t) => {
    let s = seen.get(t.id);
    if (!s) {
      s = summarize(t, routeBetween);
      seen.set(t.id, s);
    }
    return s;
  };
}
