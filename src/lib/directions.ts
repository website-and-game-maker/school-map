// Turns a computed route into instructions a person can actually follow:
// "head down the hallway, turn right, take the stairs up, 310 is on your left."
//
// Everything here is derived from the wall-aware polyline that navmesh.ts
// produces, not from the raw graph — so a turn appears in the directions at the
// same place the drawn line actually bends.

import type { FloorId } from "../types";

// --- Scale -----------------------------------------------------------------
//
// The floor plan has no printed scale bar, so this is calibrated from the
// drawing itself: adjacent classrooms along the main corridor sit a very
// consistent ~78 px apart centre-to-centre, and a standard high-school
// classroom + wall is about 30 ft. 78 / 30 ≈ 2.6 px per foot.
//
// If you ever measure a real distance in the building, correct it here — every
// distance and time estimate in the app scales off this one number.
export const PX_PER_FOOT = 2.6;

// Comfortable walking pace in a school hallway, feet per second. Deliberately
// on the slower side: between periods you are not walking in a straight line.
const FEET_PER_SECOND = 4.0;
// Rough time cost of one flight of stairs, in seconds.
const SECONDS_PER_STAIRCASE = 25;

export const FLOOR_LABELS: Record<FloorId, string> = {
  lower: "Lower Level",
  main: "Main Level",
  upper: "Upper Level",
};

const FLOOR_HEIGHT: Record<FloorId, number> = { lower: 0, main: 1, upper: 2 };

export interface RouteLeg {
  floor: FloorId;
  path: [number, number][]; // the drawn walking line on this floor
}

function pathLengthPx(path: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  }
  return total;
}

export type StepKind = "start" | "walk" | "stairs" | "arrive";

export interface DirectionStep {
  kind: StepKind;
  text: string;
  distanceFt?: number;
  floor: FloorId;
  legIndex: number; // which floor segment this step belongs to
  at: [number, number] | null; // where on that floor's image it happens
}

export interface Directions {
  steps: DirectionStep[];
  totalFeet: number;
  minutes: number;
  flights: number;
}

function bearing(a: [number, number], b: [number, number]): number {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function angleDiff(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Positive turn = clockwise on screen = a right turn for someone walking the
// route (image y grows downward, so the usual sign convention flips).
function turnPhrase(delta: number): string | null {
  const deg = (delta * 180) / Math.PI;
  const abs = Math.abs(deg);
  if (abs < 30) return null; // basically straight on
  const side = deg > 0 ? "right" : "left";
  if (abs < 60) return `Bear ${side}`;
  if (abs < 135) return `Turn ${side}`;
  return `Turn sharply ${side}`;
}

interface Run {
  start: [number, number];
  end: [number, number];
  bearing: number;
  lengthPx: number;
}

// A corridor that bends by less than this is still "the same hallway" — the
// grid path wobbles a little, and nobody wants six "keep going" steps down one
// straight corridor. Anything sharper becomes a real instruction.
const SAME_HALLWAY = (42 * Math.PI) / 180;

function reflow(run: Run) {
  run.lengthPx = Math.hypot(run.end[0] - run.start[0], run.end[1] - run.start[1]);
  run.bearing = bearing(run.start, run.end);
}

// Collapse a polyline into straight-ish runs, so a hallway that the grid drew
// as a slight zigzag reads as one "keep going" instruction.
function toRuns(path: [number, number][]): Run[] {
  const runs: Run[] = [];
  if (path.length < 2) return runs;

  let anchor = path[0];
  let currentBearing = bearing(path[0], path[1]);

  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const here = path[i];
    const legBearing = bearing(prev, here);
    if (Math.abs(angleDiff(currentBearing, legBearing)) > SAME_HALLWAY) {
      runs.push({
        start: anchor,
        end: prev,
        bearing: currentBearing,
        lengthPx: Math.hypot(prev[0] - anchor[0], prev[1] - anchor[1]),
      });
      anchor = prev;
      currentBearing = legBearing;
    }
  }
  const last = path[path.length - 1];
  runs.push({
    start: anchor,
    end: last,
    bearing: currentBearing,
    lengthPx: Math.hypot(last[0] - anchor[0], last[1] - anchor[1]),
  });

  // Drop runs too short to be worth their own instruction — nobody should be
  // told to "continue for 4 feet". A short run folds into the previous one, or
  // (if it's the very first) into the one that follows, so a leg never opens
  // with a "~0 ft" step.
  const MIN_PX = 28 * PX_PER_FOOT;
  const merged: Run[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (run.lengthPx < MIN_PX && prev) {
      prev.end = run.end;
      prev.lengthPx = Math.hypot(prev.end[0] - prev.start[0], prev.end[1] - prev.start[1]);
    } else {
      merged.push({ ...run });
    }
  }
  while (merged.length > 1 && merged[0].lengthPx < MIN_PX) {
    const [head, next] = merged;
    next.start = head.start;
    reflow(next);
    merged.shift();
  }
  for (const run of merged) reflow(run);

  // Folding short runs together shifts bearings, which can leave two
  // consecutive runs that are really one straight stretch. Collapse those, so
  // every remaining run boundary is a turn worth mentioning.
  const straightened: Run[] = [];
  for (const run of merged) {
    const prev = straightened[straightened.length - 1];
    if (prev && Math.abs(angleDiff(prev.bearing, run.bearing)) < SAME_HALLWAY) {
      prev.end = run.end;
      reflow(prev);
    } else {
      straightened.push({ ...run });
    }
  }
  return straightened;
}

function feet(px: number): number {
  return px / PX_PER_FOOT;
}

function roundFeet(ft: number): number {
  return ft >= 100 ? Math.round(ft / 10) * 10 : Math.round(ft / 5) * 5;
}

function stairPhrase(from: FloorId, to: FloorId): string {
  const up = FLOOR_HEIGHT[to] > FLOOR_HEIGHT[from];
  const flights = Math.abs(FLOOR_HEIGHT[to] - FLOOR_HEIGHT[from]);
  const dir = up ? "up" : "down";
  const many = flights > 1 ? `${flights} flights ` : "";
  return `Take the stairs ${many}${dir} to the ${FLOOR_LABELS[to]}`;
}

/**
 * Build readable directions for a whole multi-floor route.
 *
 * `legs` is one entry per floor the route passes through, in travel order,
 * each already carrying its wall-aware polyline.
 */
export function buildDirections(
  legs: RouteLeg[],
  startLabel: string,
  endLabel: string
): Directions {
  const steps: DirectionStep[] = [];
  // Measure the drawn path itself rather than summing the straightened steps —
  // the steps round corners off, the walk doesn't.
  const totalPx = legs.reduce((sum, leg) => sum + pathLengthPx(leg.path), 0);

  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];
  if (!firstLeg || !lastLeg) {
    return { steps, totalFeet: 0, minutes: 0, flights: 0 };
  }

  steps.push({
    kind: "start",
    text: `Start at ${startLabel}`,
    floor: firstLeg.floor,
    legIndex: 0,
    at: firstLeg.path[0] ?? null,
  });

  legs.forEach((leg, legIndex) => {
    const runs = toRuns(leg.path);
    const isLastLeg = legIndex === legs.length - 1;

    // On the final leg, the last run is usually the little hop off the
    // corridor into the room itself — that becomes the "arrive" step instead
    // of a walking instruction, and tells you which side the door is on.
    const walkRuns = isLastLeg && runs.length > 1 ? runs.slice(0, -1) : runs;

    walkRuns.forEach((run, i) => {
      const ft = roundFeet(feet(run.lengthPx));
      const prev = i > 0 ? walkRuns[i - 1] : null;
      const turn = prev ? turnPhrase(angleDiff(prev.bearing, run.bearing)) : null;
      let text: string;
      if (i === 0) {
        text = legIndex === 0 ? `Head down the hallway for ~${ft} ft` : `Continue for ~${ft} ft`;
      } else if (turn) {
        text = `${turn} and continue for ~${ft} ft`;
      } else {
        text = `Keep going for ~${ft} ft`;
      }
      steps.push({
        kind: "walk",
        text,
        distanceFt: ft,
        floor: leg.floor,
        legIndex,
        at: run.end,
      });
    });

    if (!isLastLeg) {
      const next = legs[legIndex + 1];
      steps.push({
        kind: "stairs",
        text: stairPhrase(leg.floor, next.floor),
        floor: leg.floor,
        legIndex,
        at: leg.path[leg.path.length - 1] ?? null,
      });
    } else {
      const finalRun = runs[runs.length - 1];
      const approach = runs.length > 1 ? runs[runs.length - 2] : null;
      let side = "";
      if (approach && finalRun) {
        const delta = angleDiff(approach.bearing, finalRun.bearing);
        const deg = Math.abs((delta * 180) / Math.PI);
        if (deg > 30) side = delta > 0 ? " on your right" : " on your left";
        else side = " straight ahead";
      }
      steps.push({
        kind: "arrive",
        text: `${endLabel} is${side || " right there"}`,
        floor: leg.floor,
        legIndex,
        at: leg.path[leg.path.length - 1] ?? null,
      });
    }
  });

  const flights = Math.max(0, legs.length - 1);
  const totalFeet = feet(totalPx);
  const seconds = totalFeet / FEET_PER_SECOND + flights * SECONDS_PER_STAIRCASE;

  return {
    steps,
    totalFeet: Math.round(totalFeet),
    minutes: Math.max(1, Math.round(seconds / 60)),
    flights,
  };
}
