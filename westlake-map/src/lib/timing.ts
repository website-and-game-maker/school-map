// Crowd-sourced walking times.
//
// The "≈ 4 min" on a route is a guess: feet ÷ a walking pace plus a fixed cost
// per staircase (directions.ts). People who actually walk the route know
// better, so the directions card has a "Time this walk" button: tap it when
// you set off, tap "I'm here" when you arrive, and that walk becomes a report.
//
// Reports are used two ways, most specific first:
//   1. The same two places (either direction): the median of those walks is
//      the estimate, outright. Nothing beats people having walked it.
//   2. Any walk: each report gives a pace (feet per second, after taking off
//      the stairs), and the median pace replaces the built-in 4 ft/s. Reports
//      from around this time of day win when there are enough of them, which
//      is how "the hallways are slow right now" shows up without a bell
//      schedule.
// With too few reports, the built-in estimate stands.
//
// Reports always live on this device. If the build sets VITE_TIMING_ENDPOINT
// they are also sent there and everyone's are read back (see api/timings.js at
// the repo root for the server and the exact contract). Without it the feature
// still works; it just only learns from you.

import { FEET_PER_SECOND, SECONDS_PER_STAIRCASE } from "./directions";

export interface TimingReport {
  /** Search-item keys of the two ends, as the From/To boxes hold them. */
  from: string;
  to: string;
  /** Length of the route that was shown, so a pace can be worked out. */
  feet: number;
  flights: number;
  /** How long the walk actually took. */
  seconds: number;
  /** When the walk ended, epoch ms. */
  at: number;
}

export interface Estimate {
  minutes: number;
  /** What the number rests on. */
  basis: "route" | "pace" | "default";
  /** How many timed walks it rests on (0 for the default). */
  count: number;
  /**
   * Set when walks around this time of day run noticeably slower than walks
   * overall: the slowdown as a fraction (0.3 = 30% slower).
   */
  busier: number | null;
}

/** Fewest walks of the exact route before their median is trusted. */
export const MIN_ROUTE_REPORTS = 2;
/** Fewest walks overall before the crowd's pace replaces the built-in one. */
export const MIN_PACE_REPORTS = 3;
/** "Around this time of day" means within this many minutes, on any day. */
const SAME_TIME_WINDOW_MIN = 30;
/** A time-of-day slowdown smaller than this is noise, not news. */
const BUSIER_THRESHOLD = 0.15;

// A walk outside these bounds is a forgotten timer or a mis-tap, not a
// measurement. 1 ft/s is a very slow shuffle; 10 ft/s is a sprint.
const MIN_PACE = 1;
const MAX_PACE = 10;
const MIN_SECONDS = 10;
const MAX_SECONDS = 20 * 60;

const STORAGE_KEY = "westlake-map:timings:v1";
const ACTIVE_KEY = "westlake-map:active-walk:v1";
/** Local reports kept; oldest drop first. */
const MAX_LOCAL = 300;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Feet per second for one walk, with the stairs taken out. */
function paceOf(r: TimingReport): number {
  const walking = r.seconds - r.flights * SECONDS_PER_STAIRCASE;
  return r.feet / Math.max(walking, 1);
}

/** Why a walk would be thrown away, or null if it is a fair measurement. */
export function rejectReason(r: Pick<TimingReport, "feet" | "flights" | "seconds">): string | null {
  if (r.seconds < MIN_SECONDS) return "That was too quick to be a real walk.";
  if (r.seconds > MAX_SECONDS) return "That took over 20 minutes, so it probably wasn't one walk.";
  const pace = paceOf({ ...r, from: "", to: "", at: 0 });
  if (pace > MAX_PACE) return "That's faster than a sprint for this distance.";
  if (pace < MIN_PACE) return "That's slower than walking pace, so something else probably happened.";
  return null;
}

export function isValidReport(x: unknown): x is TimingReport {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (
    typeof r.from === "string" &&
    typeof r.to === "string" &&
    r.from.length > 0 &&
    r.to.length > 0 &&
    r.from.length <= 64 &&
    r.to.length <= 64 &&
    num(r.feet) &&
    (r.feet as number) > 0 &&
    num(r.flights) &&
    (r.flights as number) >= 0 &&
    num(r.seconds) &&
    num(r.at) &&
    rejectReason(r as unknown as TimingReport) === null
  );
}

/** Minutes past midnight, local time. */
function minuteOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

function nearInTime(a: number, b: number): boolean {
  const d = Math.abs(minuteOfDay(a) - minuteOfDay(b));
  return Math.min(d, 1440 - d) <= SAME_TIME_WINDOW_MIN;
}

/**
 * The best estimate for a route of `feet` with `flights` staircases between
 * `from` and `to`, given every report known.
 */
export function estimate(
  from: string,
  to: string,
  feet: number,
  flights: number,
  reports: TimingReport[],
  now: number = Date.now()
): Estimate {
  const fallback = feet / FEET_PER_SECOND + flights * SECONDS_PER_STAIRCASE;
  const toMin = (s: number) => Math.max(1, Math.round(s / 60));

  const valid = reports.filter(isValidReport);
  const paces = valid.map(paceOf);
  const nowPaces = valid.filter((r) => nearInTime(r.at, now)).map(paceOf);

  // Slower now than usual? Only worth saying with enough of both to compare.
  let busier: number | null = null;
  if (paces.length >= MIN_PACE_REPORTS && nowPaces.length >= MIN_PACE_REPORTS) {
    const slowdown = median(paces) / median(nowPaces) - 1;
    if (slowdown >= BUSIER_THRESHOLD) busier = slowdown;
  }

  const same = valid.filter(
    (r) => (r.from === from && r.to === to) || (r.from === to && r.to === from)
  );
  if (same.length >= MIN_ROUTE_REPORTS) {
    let seconds = median(same.map((r) => r.seconds));
    // Walks of this route mostly timed at another hour still feel the rush.
    const sameNow = same.filter((r) => nearInTime(r.at, now));
    if (sameNow.length < MIN_ROUTE_REPORTS && busier) seconds *= 1 + busier;
    else if (sameNow.length >= MIN_ROUTE_REPORTS) seconds = median(sameNow.map((r) => r.seconds));
    return { minutes: toMin(seconds), basis: "route", count: same.length, busier };
  }

  if (paces.length >= MIN_PACE_REPORTS) {
    const pace = nowPaces.length >= MIN_PACE_REPORTS ? median(nowPaces) : median(paces);
    const seconds = feet / pace + flights * SECONDS_PER_STAIRCASE;
    return { minutes: toMin(seconds), basis: "pace", count: paces.length, busier };
  }

  return { minutes: toMin(fallback), basis: "default", count: 0, busier: null };
}

// ---------------- storage ----------------

export function loadLocalReports(): TimingReport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter(isValidReport) : [];
  } catch {
    return [];
  }
}

function saveLocalReports(reports: TimingReport[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports.slice(-MAX_LOCAL)));
  } catch {
    // Storage blocked or full: the report still goes to the server, if any.
  }
}

/** A walk being timed right now. Kept in storage so a reload or a locked phone doesn't lose it. */
export interface ActiveWalk {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  feet: number;
  flights: number;
  startedAt: number;
}

export function loadActiveWalk(): ActiveWalk | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as ActiveWalk;
    if (typeof v?.startedAt !== "number" || typeof v.from !== "string") return null;
    // A timer left running for hours was forgotten, not walked.
    if (Date.now() - v.startedAt > MAX_SECONDS * 1000 * 3) return null;
    return v;
  } catch {
    return null;
  }
}

export function saveActiveWalk(walk: ActiveWalk | null) {
  try {
    if (walk) localStorage.setItem(ACTIVE_KEY, JSON.stringify(walk));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Without storage the timer just doesn't survive a reload.
  }
}

// ---------------- sharing ----------------

const ENDPOINT: string | undefined = import.meta.env.VITE_TIMING_ENDPOINT || undefined;

/** Whether reports are pooled with everyone else's, or stay on this device. */
export const isShared = Boolean(ENDPOINT);

/** Everyone's recent reports, or [] when there's no server or it can't be reached. */
export async function fetchSharedReports(): Promise<TimingReport[]> {
  if (!ENDPOINT) return [];
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const body = (await res.json()) as { reports?: unknown };
    return Array.isArray(body.reports) ? body.reports.filter(isValidReport) : [];
  } catch {
    return [];
  }
}

/** Record a finished walk here, and send it to the shared pool if there is one. */
export async function submitReport(report: TimingReport): Promise<void> {
  saveLocalReports([...loadLocalReports(), report]);
  if (!ENDPOINT) return;
  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
  } catch {
    // Offline: it is still counted on this device.
  }
}

/**
 * Local and shared reports together. The device's own walks are also in the
 * shared pool once sent, so duplicates (same ends, same moment) are dropped.
 */
export function mergeReports(local: TimingReport[], shared: TimingReport[]): TimingReport[] {
  const seen = new Set<string>();
  const out: TimingReport[] = [];
  for (const r of [...local, ...shared]) {
    const id = `${r.from}|${r.to}|${r.at}|${r.seconds}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}
