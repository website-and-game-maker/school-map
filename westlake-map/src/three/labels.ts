// Place names on the map, drawn the way a street map draws them.
//
// They are HTML, laid over the canvas and re-projected whenever the scene
// renders, rather than text baked into the floor texture or sprites in the
// scene. That is the whole difference between "a map" and "a model with
// writing on it":
//
//   - the text is the same size at every zoom, so it is always readable and
//     never a smear at the far edge of a tilted floor;
//   - names that would collide are dropped, most important first, so zooming
//     out thins the map instead of piling numbers on top of each other;
//   - room numbers only appear once you are close enough for a room to be a
//     thing you could tap, like street names on a city map.
//
// Only the floor being read gets labels. The others are either hidden (flat)
// or ghosts (tilted), and names on a ghost are exactly the "which floor is 214
// on" confusion the floor selector exists to remove.

import * as THREE from "three";

import { PLACE_INK, placeCategory } from "../lib/placeCategory";
import type { FloorData, FloorId, FloorPoint } from "../types";
import type { PlacementSet } from "./placement";
import { planToWorld } from "./placement";
import { storeyY } from "./units";
import { categoryIcon } from "./icons";

export type LabelKind = "landmark" | "entrance" | "room" | "restroom" | "stairs" | "street" | "ground";

export interface MapLabelItem {
  key: string;
  floor: FloorId;
  /** The point's id in that floor's data — what a tap hands back. */
  id: string;
  text: string;
  kind: LabelKind;
  world: THREE.Vector3;
}

/** Lower draws first and wins collisions. */
const PRIORITY: Record<LabelKind, number> = {
  landmark: 0,
  entrance: 1,
  restroom: 2,
  stairs: 3,
  room: 4,
  // The world outside (outdoor.ts): fields first, then streets. They lose
  // every collision with the school's own names, which is the point.
  ground: 5,
  street: 6,
};

/**
 * Screen pixels per foot below which room numbers are left off. At about one
 * pixel a foot the whole school fills a laptop screen, and a 30 ft classroom is
 * 30 px — too small to carry its number legibly next to its neighbours'.
 */
const ROOM_MIN_PX_PER_FOOT = 1.15;
/** Clear space kept around each label, in CSS px. */
const PADDING = 3;

function labelKind(p: FloorPoint): LabelKind | null {
  // A room with a name (the Black Box Theater, the Sub-Varsity Gym) is a
  // place people navigate by, so it is drawn like one, at every zoom.
  // The scan reader also sets `label` on plain numbered rooms, so "has a
  // label" is not the test; "is a word" is.
  if (p.kind === "room") return p.label && /[a-z]{3}/i.test(p.label) ? "landmark" : "room";
  if (p.kind === "landmark") return "landmark";
  if (p.kind === "entrance") return "entrance";
  if (p.kind === "poi" && p.poiType === "restroom") return "restroom";
  if (p.kind === "poi" && p.poiType === "stairs") return "stairs";
  return null; // junctions are routing scaffolding, not places
}

function labelText(id: string, p: FloorPoint, kind: LabelKind): string {
  if (kind === "restroom") return p.label || "Restroom";
  if (kind === "stairs") return p.label || "Stairs";
  return p.label ?? id;
}

/** Every nameable place on every floor, in world space. */
export function buildLabelItems(
  floors: Record<FloorId, FloorData>,
  placements: PlacementSet,
  spread: number
): MapLabelItem[] {
  const out: MapLabelItem[] = [];
  for (const floor of Object.keys(floors) as FloorId[]) {
    const y = storeyY(floor, spread);
    for (const [id, p] of Object.entries(floors[floor].points)) {
      const kind = labelKind(p);
      if (!kind) continue;
      const [wx, wy, wz] = planToWorld(placements[floor], p.x, p.y, y);
      out.push({
        key: `${floor}:${id}`,
        floor,
        id,
        text: labelText(id, p, kind),
        kind,
        world: new THREE.Vector3(wx, wy, wz),
      });
    }
  }
  out.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  return out;
}

interface Placed {
  item: MapLabelItem;
  node: HTMLElement;
  w: number;
  h: number;
  /** Screen position from the last layout, or null when it was culled. */
  at: [number, number] | null;
}

export class MapLabels {
  private el: HTMLDivElement;
  private placed: Placed[] = [];
  private floor: FloorId | null = null;
  private all: MapLabelItem[] = [];
  private v = new THREE.Vector3();
  /** The blue "you are here" dot: drawn under the names, never culled by them. */
  private hereNode: HTMLDivElement;
  private here: { at: THREE.Vector3; floor: FloorId } | null = null;

  constructor(host: HTMLElement) {
    this.hereNode = document.createElement("div");
    this.hereNode.className = "map-here";
    this.hereNode.setAttribute("aria-hidden", "true");
    this.hereNode.style.visibility = "hidden";
    host.appendChild(this.hereNode);
    this.el = document.createElement("div");
    this.el.className = "map-labels";
    this.el.setAttribute("aria-hidden", "true");
    host.appendChild(this.el);
  }

  setHere(at: THREE.Vector3 | null, floor: FloorId | null): void {
    this.here = at && floor ? { at: at.clone(), floor } : null;
  }

  /** Replace the set of places. Cheap enough to call on any data change. */
  setItems(items: MapLabelItem[]): void {
    this.all = items;
    const f = this.floor;
    this.floor = null;
    if (f) this.setFloor(f);
  }

  setFloor(floor: FloorId): void {
    if (floor === this.floor) return;
    this.floor = floor;
    this.el.replaceChildren();
    this.placed = [];
    for (const item of this.all) {
      if (item.floor !== floor) continue;
      const node = document.createElement("div");
      node.className = `map-label map-label-${item.kind}`;
      if (item.kind === "landmark") {
        // A coloured pin, the way a street map marks a park or a café.
        const cat = placeCategory(item.text);
        const ink = PLACE_INK[cat];
        const icon = document.createElement("span");
        icon.className = "map-label-icon map-label-pin";
        icon.style.background = ink;
        icon.appendChild(categoryIcon(cat));
        node.appendChild(icon);
        node.style.color = ink;
      } else if (item.kind === "restroom" || item.kind === "stairs" || item.kind === "entrance") {
        const icon = document.createElement("span");
        icon.className = "map-label-icon";
        icon.textContent =
          item.kind === "restroom" ? "WC" : item.kind === "stairs" ? "⇅" : entranceLetter(item.text);
        node.appendChild(icon);
      }
      const text = document.createElement("span");
      text.className = "map-label-text";
      text.textContent = item.text;
      node.appendChild(text);
      this.el.appendChild(node);
      this.placed.push({ item, node, w: 0, h: 0, at: null });
    }
    // One forced layout for the lot, not one per frame: sizes never change.
    for (const p of this.placed) {
      p.w = p.node.offsetWidth;
      p.h = p.node.offsetHeight;
      p.node.style.visibility = "hidden";
    }
  }

  /**
   * Project every label and keep the ones that fit. Called from the render
   * loop, so it only runs when the picture actually changed.
   */
  layout(camera: THREE.Camera, w: number, h: number, pxPerFoot: number, hidden: boolean): void {
    const boxes: number[] = [];
    let hereShown = false;
    if (this.here && !hidden && this.here.floor === this.floor) {
      this.v.copy(this.here.at).project(camera);
      if (this.v.z <= 1 && this.v.z >= -1) {
        const x = ((this.v.x + 1) / 2) * w;
        const y = ((1 - this.v.y) / 2) * h;
        this.hereNode.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        // No collision box: the dot sits on the very room it names, and that
        // room's label is the one name you most want to keep.
        hereShown = true;
      }
    }
    this.hereNode.style.visibility = hereShown ? "visible" : "hidden";
    const showRooms = pxPerFoot >= ROOM_MIN_PX_PER_FOOT;
    for (const p of this.placed) {
      let show = !hidden && (p.item.kind !== "room" || showRooms);
      let x = 0;
      let y = 0;
      if (show) {
        this.v.copy(p.item.world).project(camera);
        if (this.v.z > 1 || this.v.z < -1) show = false;
        x = ((this.v.x + 1) / 2) * w;
        y = ((1 - this.v.y) / 2) * h;
        // The place you are at keeps its name, just under the blue dot.
        if (hereShown && this.here && p.item.world.distanceToSquared(this.here.at) < 1) y += 9 + p.h / 2;
        // Whole labels only: half a name at the edge reads as a different name.
        if (x - p.w / 2 < 2 || x + p.w / 2 > w - 2 || y - p.h / 2 < 2 || y + p.h / 2 > h - 2) show = false;
      }
      if (show) {
        const x0 = x - p.w / 2 - PADDING;
        const y0 = y - p.h / 2 - PADDING;
        const x1 = x + p.w / 2 + PADDING;
        const y1 = y + p.h / 2 + PADDING;
        for (let i = 0; i < boxes.length; i += 4) {
          if (x0 < boxes[i + 2] && x1 > boxes[i] && y0 < boxes[i + 3] && y1 > boxes[i + 1]) {
            show = false;
            break;
          }
        }
        if (show) boxes.push(x0, y0, x1, y1);
      }
      if (show) {
        p.at = [x, y];
        p.node.style.visibility = "visible";
        p.node.style.transform = `translate(${(x - p.w / 2).toFixed(1)}px, ${(y - p.h / 2).toFixed(1)}px)`;
      } else if (p.at) {
        p.at = null;
        p.node.style.visibility = "hidden";
      }
    }
  }

  /** The label drawn nearest a screen point, if one is within reach of it. */
  hitTest(x: number, y: number, slop = 10): MapLabelItem | null {
    let best: MapLabelItem | null = null;
    let bestD = Infinity;
    for (const p of this.placed) {
      // Streets and fields are context, not places the app can route to.
      if (!p.at || p.item.kind === "street" || p.item.kind === "ground") continue;
      const dx = Math.max(0, Math.abs(x - p.at[0]) - p.w / 2);
      const dy = Math.max(0, Math.abs(y - p.at[1]) - p.h / 2);
      const d = Math.hypot(dx, dy);
      if (d <= slop && d < bestD) {
        bestD = d;
        best = p.item;
      }
    }
    return best;
  }

  dispose(): void {
    this.el.remove();
    this.hereNode.remove();
    this.placed = [];
  }
}

/** "Front Door (A)" -> "A"; anything else -> its first letter. */
function entranceLetter(text: string): string {
  const m = /\(([A-Z])\)\s*$/.exec(text);
  return m ? m[1] : text.charAt(0).toUpperCase();
}
