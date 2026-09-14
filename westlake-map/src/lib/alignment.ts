// Nudging one storey onto another, by hand.
//
// This is the job CLAUDE.md has had at the top of its list for a while: the
// three plan sheets are separate scans with no registration marks, so where a
// storey sits relative to the others is fitted from a handful of shared
// entrances and is wrong by 10-51 ft. No amount of cleverness fixes that —
// there is no signal left in the scans to fit against. What fixes it is a
// person looking at the overlay and dragging until the outside walls line up,
// which takes about ten minutes and closes the largest accuracy gap in the 3D
// view.
//
// So the editor gets nudge controls, and the 3D view re-registers live. The
// stair columns are the instrument you read while doing it: when two floors are
// misaligned, the column joining their stairwells leans, and it stands up as
// you get the registration right.
//
// Main is the reference frame and cannot be moved — something has to be, and
// main is the sheet every other placement was fitted against.

import type { FloorId } from "../types";
import type { FloorPlacement, PlacementSet } from "../three/placement";
import { loadPlacements } from "../three/placement";

export const REFERENCE_FLOOR: FloorId = "main";

/** Step sizes, in plan px and percent, for one press of a nudge control. */
export const NUDGE = {
  coarse: 25,
  fine: 4,
  scale: 0.004,
  rotation: 0.25,
} as const;

export function initialPlacements(): PlacementSet {
  // Cloned: the JSON import is module state shared with everything else that
  // reads it, and the editor mutates its copy.
  const base = loadPlacements();
  return {
    lower: { ...base.lower },
    main: { ...base.main },
    upper: { ...base.upper },
  };
}

export function nudge(
  set: PlacementSet,
  floor: FloorId,
  change: Partial<Pick<FloorPlacement, "tx" | "ty" | "scale" | "rotationDeg">>
): PlacementSet {
  if (floor === REFERENCE_FLOOR) return set;
  const p = set[floor];
  return {
    ...set,
    [floor]: {
      ...p,
      tx: change.tx !== undefined ? p.tx + change.tx : p.tx,
      ty: change.ty !== undefined ? p.ty + change.ty : p.ty,
      // A storey that has been touched is no longer the fitted guess, but it is
      // not "verified" either until the person says so — see markVerified.
      scale: change.scale !== undefined ? Math.max(0.2, p.scale + change.scale) : p.scale,
      rotationDeg:
        change.rotationDeg !== undefined ? p.rotationDeg + change.rotationDeg : p.rotationDeg,
    },
  };
}

export function markVerified(set: PlacementSet, floor: FloorId, verified: boolean): PlacementSet {
  return { ...set, [floor]: { ...set[floor], verified } };
}

export function isDirty(set: PlacementSet): boolean {
  const base = loadPlacements();
  return (["lower", "main", "upper"] as FloorId[]).some((f) => {
    const a = set[f];
    const b = base[f];
    return (
      Math.abs(a.tx - b.tx) > 0.01 ||
      Math.abs(a.ty - b.ty) > 0.01 ||
      Math.abs(a.scale - b.scale) > 1e-6 ||
      Math.abs(a.rotationDeg - b.rotationDeg) > 1e-6 ||
      a.verified !== b.verified
    );
  });
}

/** Round to the precision align3d.json actually carries, so diffs stay small. */
export function forFile(set: PlacementSet): PlacementSet {
  const tidy = (p: FloorPlacement): FloorPlacement => ({
    floor: p.floor,
    scale: Number(p.scale.toFixed(4)),
    rotationDeg: Number(p.rotationDeg.toFixed(3)),
    tx: Number(p.tx.toFixed(1)),
    ty: Number(p.ty.toFixed(1)),
    verified: p.verified,
  });
  return { lower: tidy(set.lower), main: tidy(set.main), upper: tidy(set.upper) };
}

/** A plain-English account of what was moved, for the proposal's summary. */
export function describe(set: PlacementSet): string[] {
  const base = loadPlacements();
  const out: string[] = [];
  for (const f of ["lower", "upper"] as FloorId[]) {
    const a = set[f];
    const b = base[f];
    const bits: string[] = [];
    const dx = a.tx - b.tx;
    const dy = a.ty - b.ty;
    if (Math.hypot(dx, dy) > 0.5) {
      bits.push(`moved ${Math.round(dx)},${Math.round(dy)} px`);
    }
    if (Math.abs(a.scale - b.scale) > 1e-4) {
      bits.push(`scale ${b.scale.toFixed(4)} → ${a.scale.toFixed(4)}`);
    }
    if (Math.abs(a.rotationDeg - b.rotationDeg) > 1e-3) {
      bits.push(`rotated ${(a.rotationDeg - b.rotationDeg).toFixed(2)}°`);
    }
    if (a.verified !== b.verified) {
      bits.push(a.verified ? "marked verified by eye" : "no longer marked verified");
    }
    if (bits.length) out.push(`${f} level: ${bits.join(", ")}`);
  }
  return out.length ? out : ["no alignment changes"];
}
