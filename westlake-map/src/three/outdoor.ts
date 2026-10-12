// The real world around the school: streets, fields, car parks and the
// neighbouring buildings, from OpenStreetMap.
//
// The data is baked by tools/export_outdoor.py into world feet already, so
// nothing here knows about latitude or longitude. That script is also where
// the placement comes from (the plan registered against OSM's footprint of
// the building) and where its accuracy is recorded.
//
// It is drawn the way a street map draws its base layer: flat, unlit, quiet
// colours, so the school stays the subject and the route stays the brightest
// thing on screen. Everything here sits just under the slab of whichever
// storey is being read — the viewer moves the group — so the floor you are
// looking at always has its surroundings around it, and the slab covers the
// building's own OSM footprint wherever the two overlap.
//
// Nothing writes depth. The layers are coplanar, so they are painted in
// renderOrder, and the storeys below still show through when the map tilts.

import * as THREE from "three";
import outdoor from "../data/outdoor.json";

type AreaKind = "school" | "wood" | "grass" | "parking" | "pitch" | "track" | "water";
type RoadKind = "path" | "service" | "minor" | "major";

interface OutdoorFile {
  source: string;
  areas: Array<{ k: AreaKind; rings: number[][] }>;
  buildings: number[][];
  roads: Array<{ k: RoadKind; pts: number[] }>;
  labels: Array<{ text: string; x: number; z: number; k: "area" | "road" }>;
}

const DATA = outdoor as unknown as OutdoorFile;

export const OUTDOOR_ATTRIBUTION = DATA.source;

const AREA_COLOR: Record<AreaKind, number> = {
  school: 0xe5e1d8,
  wood: 0xd2dec3,
  grass: 0xdae6cb,
  parking: 0xdfdbd4,
  pitch: 0xc8dcb2,
  track: 0xe2cbbb,
  water: 0xb6d4e1,
};
// Track before pitch: OSM draws a running track as the whole oval, and the
// stadium field inside it should still read as grass.
const AREA_ORDER: AreaKind[] = ["school", "wood", "grass", "parking", "track", "pitch", "water"];

/** Width in feet of the casing (outline) and fill of each kind of road. */
const ROAD_STYLE: Record<RoadKind, { casing: number; fill: number; color: number }> = {
  path: { casing: 0, fill: 4, color: 0xf8f6f1 },
  service: { casing: 15, fill: 11, color: 0xffffff },
  minor: { casing: 28, fill: 22, color: 0xffffff },
  major: { casing: 42, fill: 34, color: 0xfff6dc },
};
const ROAD_ORDER: RoadKind[] = ["path", "service", "minor", "major"];
const CASING = 0xcdc5b9;

const BUILDING_FILL = 0xdcd6cc;
const BUILDING_LINE = 0xbfb5a7;

export interface OutdoorLabel {
  text: string;
  kind: "area" | "road";
  x: number;
  z: number;
}

export interface OutdoorLayer {
  group: THREE.Group;
  labels: OutdoorLabel[];
  dispose(): void;
}

/** Triangulated polygons (outer ring + holes) as one flat XZ geometry. */
function fillGeometry(polys: number[][][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const v2 = (flat: number[]) => {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < flat.length; i += 2) out.push(new THREE.Vector2(flat[i], flat[i + 1]));
    return out;
  };
  for (const rings of polys) {
    const outer = v2(rings[0]);
    if (outer.length < 3) continue;
    const holes = rings.slice(1).map(v2);
    let faces: number[][];
    try {
      faces = THREE.ShapeUtils.triangulateShape(outer, holes);
    } catch {
      continue;
    }
    const all = outer.concat(...holes);
    for (const f of faces) for (const i of f) pos.push(all[i].x, 0, all[i].y);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/**
 * Polylines as flat ribbons of a given width: one quad per segment and a disc
 * at every vertex, which gives round joins and caps without any miter maths.
 * Overlaps are harmless because nothing writes depth and it is one colour.
 */
function ribbonGeometry(lines: number[][], width: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const r = width / 2;
  const SIDES = 10;
  const disc = (x: number, z: number) => {
    for (let k = 0; k < SIDES; k++) {
      const a0 = (k / SIDES) * Math.PI * 2;
      const a1 = ((k + 1) / SIDES) * Math.PI * 2;
      pos.push(x, 0, z, x + Math.cos(a1) * r, 0, z + Math.sin(a1) * r, x + Math.cos(a0) * r, 0, z + Math.sin(a0) * r);
    }
  };
  for (const p of lines) {
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i], z0 = p[i + 1], x1 = p[i + 2], z1 = p[i + 3];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-6) continue;
      const nx = (-(z1 - z0) / len) * r;
      const nz = ((x1 - x0) / len) * r;
      pos.push(x0 + nx, 0, z0 + nz, x1 + nx, 0, z1 + nz, x1 - nx, 0, z1 - nz);
      pos.push(x0 + nx, 0, z0 + nz, x1 - nx, 0, z1 - nz, x0 - nx, 0, z0 - nz);
    }
    for (let i = 0; i + 1 < p.length; i += 2) disc(p[i], p[i + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

function outlineGeometry(rings: number[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      pos.push(ring[2 * i], 0, ring[2 * i + 1], ring[2 * j], 0, ring[2 * j + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

export function buildOutdoor(): OutdoorLayer {
  const group = new THREE.Group();
  group.name = "outdoor";
  const owned: Array<{ dispose(): void }> = [];
  // Well below every other renderOrder in the scene, so the slab, walls,
  // route and markers always paint over the ground.
  let order = -100;

  const add = (geom: THREE.BufferGeometry, color: number, line = false) => {
    const mat = line
      ? new THREE.LineBasicMaterial({ color, depthWrite: false })
      : new THREE.MeshBasicMaterial({ color, depthWrite: false, side: THREE.DoubleSide });
    const obj = line ? new THREE.LineSegments(geom, mat) : new THREE.Mesh(geom, mat);
    obj.renderOrder = order++;
    obj.matrixAutoUpdate = false;
    obj.updateMatrix();
    group.add(obj);
    owned.push(geom, mat);
  };

  for (const kind of AREA_ORDER) {
    const polys = DATA.areas.filter((a) => a.k === kind).map((a) => a.rings);
    if (polys.length) add(fillGeometry(polys), AREA_COLOR[kind]);
  }

  // Casings first, all kinds, then fills: where a side street meets a main
  // road the two fills join cleanly instead of one road's outline cutting
  // across the other.
  const linesOf = (k: RoadKind) => DATA.roads.filter((r) => r.k === k).map((r) => r.pts);
  for (const kind of ROAD_ORDER) {
    const s = ROAD_STYLE[kind];
    if (s.casing > 0) add(ribbonGeometry(linesOf(kind), s.casing), CASING);
  }
  for (const kind of ROAD_ORDER) {
    const s = ROAD_STYLE[kind];
    add(ribbonGeometry(linesOf(kind), s.fill), s.color);
  }

  // Buildings over roads: OSM draws covered walkways and porte-cochères as
  // service roads running under the building outline.
  add(fillGeometry(DATA.buildings.map((r) => [r])), BUILDING_FILL);
  add(outlineGeometry(DATA.buildings), BUILDING_LINE, true);

  return {
    group,
    labels: DATA.labels.map((l) => ({ text: l.text, kind: l.k, x: l.x, z: l.z })),
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}

/** The credit OSM's licence asks for, in the corner of the map. */
export function createAttribution(host: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = "map-attribution";
  const a = document.createElement("a");
  a.href = "https://www.openstreetmap.org/copyright";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "© OpenStreetMap contributors";
  el.appendChild(a);
  host.appendChild(el);
  return el;
}
