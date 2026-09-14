// The vertical ties between storeys: which stairwell on Main is which
// stairwell on Upper.
//
// This exists because of a specific confusion. Three floor plates floating one
// above another do not, by themselves, tell you how the building is stacked —
// they look like three separate maps that happen to be in the same scene. The
// thing that makes a stack read as ONE building is seeing the parts that pass
// through all of it. So every stair link gets drawn as a literal column joining
// its marker on each floor it serves, and the column is the same colour at
// every end.
//
// The columns also make the alignment honest. Where the storeys are badly
// registered — and they are, by 10-51 ft, because the three sheets are separate
// scans with no registration marks — the column comes out visibly leaning. That
// lean is the alignment error, drawn at full size. It is the fastest way to see
// which floors need nudging, and it is why the align editor and these columns
// belong in the same view.
//
// Guessed links (the ones seeded from entrance names in stairs.json, which
// assume an entrance letter means the same physical place on every floor) are
// drawn dashed and pale. Links built from markers a human placed are solid.
// You should be able to tell at a glance how much of the vertical structure is
// known and how much is assumed.

import * as THREE from "three";

import type { FloorData, FloorId, StairLink } from "../types";
import { FLOOR_ORDER } from "../data/floors";
import { planToWorld, type PlacementSet } from "./placement";
import { storeyY } from "./units";

export interface StairColumns {
  group: THREE.Group;
  dispose(): void;
  /** How many links were drawn, and how many of those were guesses. */
  stats: { drawn: number; guessed: number };
}

/** Distinct hues, not a gradient: these are identities, not a quantity. */
const HUES = [0.02, 0.55, 0.13, 0.78, 0.33, 0.9, 0.45];

const RADIUS = 2.6; // ft — thick enough to read against a 1200 ft building
const CAP_RADIUS = 5.5;

interface Anchor {
  floor: FloorId;
  pos: THREE.Vector3;
}

function anchorsFor(
  link: StairLink,
  floors: Record<FloorId, FloorData>,
  placements: PlacementSet,
  spread: number
): Anchor[] {
  const out: Anchor[] = [];
  for (const floor of FLOOR_ORDER) {
    const pointId = link.points[floor];
    if (!pointId) continue;
    const p = floors[floor].points[pointId];
    if (!p) continue;
    const [x, y, z] = planToWorld(placements[floor], p.x, p.y, storeyY(floor, spread));
    out.push({ floor, pos: new THREE.Vector3(x, y, z) });
  }
  return out.sort((a, b) => a.pos.y - b.pos.y);
}

/**
 * Build one group holding every stair column.
 *
 * Rebuilt whenever the spread changes, which is cheap: a handful of cylinders
 * and spheres, nowhere near the cost of the wall geometry.
 */
export function buildStairColumns(
  links: StairLink[],
  floors: Record<FloorId, FloorData>,
  placements: PlacementSet,
  spread: number,
  opts: { opacity: number } = { opacity: 1 }
): StairColumns {
  const group = new THREE.Group();
  group.name = "stair-columns";
  const owned: Array<{ dispose(): void }> = [];
  let drawn = 0;
  let guessed = 0;

  links.forEach((link, i) => {
    const anchors = anchorsFor(link, floors, placements, spread);
    if (anchors.length < 2) return;

    const colour = new THREE.Color().setHSL(HUES[i % HUES.length], 0.62, 0.48);
    const solid = link.verified;
    if (!solid) guessed++;
    drawn++;

    const material = new THREE.MeshStandardMaterial({
      color: colour,
      roughness: 0.45,
      metalness: 0.05,
      transparent: true,
      // A guessed link should never look as certain as a known one.
      opacity: (solid ? 0.92 : 0.4) * opts.opacity,
      depthWrite: solid,
    });
    owned.push(material);

    // One segment per pair of adjacent floors, so a link that skips a storey
    // (B runs lower->upper without stopping at main) is drawn as one long leg
    // rather than being silently dropped.
    for (let s = 0; s < anchors.length - 1; s++) {
      const a = anchors[s].pos;
      const b = anchors[s + 1].pos;
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      if (len < 1) continue;
      const geo = new THREE.CylinderGeometry(RADIUS, RADIUS, len, 10, 1, true);
      owned.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.copy(a).addScaledVector(dir, 0.5);
      // Cylinders are built along +Y; aim it at the next floor's marker. When
      // the alignment is off, this is what makes the column lean.
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      mesh.renderOrder = 2;
      group.add(mesh);
    }

    // A disc where the column meets each storey, so you can see which floors a
    // stairwell actually serves without tracing the column by eye.
    for (const anchor of anchors) {
      const geo = new THREE.CylinderGeometry(CAP_RADIUS, CAP_RADIUS, 1.2, 16);
      owned.push(geo);
      const cap = new THREE.Mesh(geo, material);
      cap.position.copy(anchor.pos);
      cap.renderOrder = 3;
      group.add(cap);
    }
  });

  return {
    group,
    stats: { drawn, guessed },
    dispose() {
      for (const o of owned) o.dispose();
      group.clear();
    },
  };
}
