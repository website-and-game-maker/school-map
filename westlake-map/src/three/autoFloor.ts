// Which floor is the map looking at?
//
// The floor selector picks itself. A route already moves it (each leg is on a
// floor), and this is the other half: pan or zoom the map onto part of the
// school and the floor that actually has something there becomes the one you
// are reading, the way an indoor map switches to the building you zoom into.
//
// "Something there" is counted, not guessed: every room, named place,
// entrance and marked restroom or stairwell is an anchor, and a floor's score
// is how many of its anchors sit inside a circle around the middle of the
// view. The circle scales with zoom, so at street level it is a few rooms
// across and at building level it is a wing.
//
// The storeys overlap over much of the building, but not evenly: the 100s
// sit under the south-east, the upper wings run along the west, and Main
// fills the middle. So a floor only takes over where it has at least TAKEOVER
// times as much under the view as the floor you are on. Where two floors are
// about level, nothing on screen says which one you mean, and the floor you
// are on stays put — without that dead band, panning across the middle of the
// school would flick between floors under your finger.

import type { FloorId } from "../types";

export type FloorAnchors = Record<FloorId, Float32Array>;

/** How much busier another floor has to be before it takes over. */
const TAKEOVER = 2;
/** The fewest places a floor needs in view to take over at all. */
const ENOUGH = 3;

/**
 * The floor to show, given the current one and the view's centre (world X/Z,
 * feet) and radius (feet). Returns `current` when the answer is unclear.
 */
export function pickFloor(
  anchors: FloorAnchors,
  order: readonly FloorId[],
  current: FloorId,
  cx: number,
  cz: number,
  radius: number
): FloorId {
  const r2 = radius * radius;
  const score = {} as Record<FloorId, number>;
  for (const f of order) {
    const a = anchors[f];
    let n = 0;
    for (let i = 0; i < a.length; i += 2) {
      const dx = a[i] - cx;
      const dz = a[i + 1] - cz;
      if (dx * dx + dz * dz <= r2) n++;
    }
    score[f] = n;
  }

  const mine = score[current];
  let best = current;
  for (const f of order) {
    if (score[f] > score[best]) best = f;
    // Ties go to whichever is nearer the floor you are on: one flight, not two.
    else if (score[f] === score[best] && f !== best && dist(order, f, current) < dist(order, best, current)) best = f;
  }
  if (best === current) return current;
  if (score[best] < Math.max(ENOUGH, mine * TAKEOVER)) return current;
  return best;
}

function dist(order: readonly FloorId[], a: FloorId, b: FloorId): number {
  return Math.abs(order.indexOf(a) - order.indexOf(b));
}
