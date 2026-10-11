// Names in the 3D view: entrances, landmarks, and the two ends of the route.
//
// HTML, not sprites. A canvas-texture sprite is a bitmap scaled by perspective,
// so it is either blurry up close or illegible far away, and its text size
// changes as you orbit. A DOM label is set by the browser's own text renderer
// at a fixed CSS size: always crisp, always readable, and it costs nothing on
// the GPU. The price is projecting each anchor once per rendered frame — a few
// dozen matrix multiplies — and that only happens when the viewer renders,
// which is on demand.
//
// Rooms are deliberately NOT labelled. Their numbers are printed on the floor
// texture already, at their real size and position; a second copy floating
// above each one would be 200 labels of clutter saying the same thing twice.
//
// The viewer owns this layer the same way it owns every three.js object: React
// never sees these nodes.

import * as THREE from "three";
import type { FloorData, FloorId } from "../types";
import type { Route3D } from "./routeLift";
import { planToWorld, type PlacementSet } from "./placement";
import { GHOST_WALL_FACTOR, storeyY } from "./units";
import { FLOOR_ORDER } from "../data/floors";

/** Lower draws first and wins a collision. */
export type LabelTier = "start" | "end" | "entrance" | "landmark";
const TIER_RANK: Record<LabelTier, number> = { start: 0, end: 0, entrance: 1, landmark: 2 };

/** How far above the slab a place label floats, feet. Clear of the ribbon. */
const POINT_LIFT_FT = 4;
/** Gap kept around each label when testing for overlap, CSS px. */
const PAD_PX = 3;
/** Below this opacity a label is not worth a slot in the collision pass. */
const MIN_OPACITY = 0.05;

export interface LabelSpec {
  key: string;
  text: string;
  floor: FloorId;
  world: [number, number, number];
  tier: LabelTier;
}

interface LabelItem {
  spec: LabelSpec;
  node: HTMLDivElement;
  w: number;
  h: number;
  /** Last values written, so a still label costs no DOM write. */
  shownTransform: string;
  shownOpacity: string;
  visible: boolean;
}

/** The labels a set of floors and a route ask for. No DOM here, so the layer
 *  below only ever diffs a plain list. */
export function labelSpecs(
  floors: Record<FloorId, FloorData>,
  placements: PlacementSet,
  spread: number,
  route: Route3D | null,
  ends: { start: string; end: string } | null
): LabelSpec[] {
  const out: LabelSpec[] = [];
  if (route && ends && route.legs.length > 0) {
    const n = route.cumulative.length;
    const p = route.points;
    // The start disc sits on the floor; the destination has a 17 ft spike and
    // ball, and its name belongs above that, not through it.
    out.push({
      key: "route:start",
      text: ends.start,
      floor: route.legs[0].floor,
      world: [p[0], p[1] + 6, p[2]],
      tier: "start",
    });
    out.push({
      key: "route:end",
      text: ends.end,
      floor: route.legs[route.legs.length - 1].floor,
      world: [p[(n - 1) * 3], p[(n - 1) * 3 + 1] + 19, p[(n - 1) * 3 + 2]],
      tier: "end",
    });
  }
  for (const floor of FLOOR_ORDER) {
    const data = floors[floor];
    const place = placements[floor];
    const y = storeyY(floor, spread) + POINT_LIFT_FT;
    for (const [id, pt] of Object.entries(data.points)) {
      if (pt.kind !== "entrance" && pt.kind !== "landmark") continue;
      const text = pt.label ?? id;
      out.push({
        key: `${floor}:${id}`,
        text,
        floor,
        world: planToWorld(place, pt.x, pt.y, y),
        tier: pt.kind,
      });
    }
  }
  return out;
}

export class LabelLayer {
  readonly el: HTMLDivElement;
  private items: LabelItem[] = [];
  private readonly v = new THREE.Vector3();

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "labels-3d";
    this.el.setAttribute("aria-hidden", "true"); // the panel already says all of this in words
    host.appendChild(this.el);
  }

  /** Replace the label set, reusing nodes by key so a route change does not
   *  rebuild forty unrelated labels. */
  setLabels(specs: LabelSpec[]): void {
    const old = new Map(this.items.map((it) => [it.spec.key, it]));
    const next: LabelItem[] = [];
    for (const spec of specs) {
      let it = old.get(spec.key);
      if (it) {
        old.delete(spec.key);
        if (it.spec.text !== spec.text || it.spec.tier !== spec.tier) {
          it.node.textContent = spec.text;
          it.node.className = `label-3d tier-${spec.tier}`;
          it.w = 0; // re-measure
        }
        it.spec = spec;
      } else {
        const node = document.createElement("div");
        node.className = `label-3d tier-${spec.tier}`;
        node.textContent = spec.text;
        node.style.visibility = "hidden";
        this.el.appendChild(node);
        it = { spec, node, w: 0, h: 0, shownTransform: "", shownOpacity: "", visible: false };
      }
      next.push(it);
    }
    for (const it of old.values()) it.node.remove();
    this.items = next;
  }

  /**
   * Place every label for this frame.
   *
   * `ghost` is the same opacity the viewer gives the unfocused storeys
   * (`ghostOpacityForDimension`), so a storey's names fade exactly as its
   * walls do and vanish with them looking straight down.
   *
   * Overlap is settled greedily: route ends, then entrances, then landmarks;
   * within a tier the focused storey first, then nearest the camera. A label
   * that would touch one already placed is dropped for this frame, and so is a
   * second label with the same text (an entrance letter exists on every storey
   * it serves; saying "Front Door (A)" three times helps nobody).
   */
  update(
    camera: THREE.Camera,
    width: number,
    height: number,
    activeFloor: FloorId,
    ghost: number
  ): void {
    // Read phase first: measuring between writes would force a layout per label.
    for (const it of this.items) {
      if (it.w === 0) {
        it.w = it.node.offsetWidth;
        it.h = it.node.offsetHeight;
      }
    }

    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const cand: { it: LabelItem; x: number; y: number; opacity: number; rank: number; d: number }[] = [];
    for (const it of this.items) {
      const { spec } = it;
      const focused = spec.floor === activeFloor;
      const isEnd = spec.tier === "start" || spec.tier === "end";
      // Route ends stay readable on any storey: they are what you asked for.
      // Anything else on an unfocused storey takes that storey's WALL opacity;
      // at the plain ghost value a Lower landmark seen through Main read as if
      // it were on the floor you are looking at.
      const opacity = isEnd || focused ? 1 : ghost * GHOST_WALL_FACTOR;
      if (opacity < MIN_OPACITY) continue;
      this.v.set(spec.world[0], spec.world[1], spec.world[2]).project(camera);
      if (this.v.z < -1 || this.v.z > 1) continue; // behind the camera or past far
      const x = ((this.v.x + 1) / 2) * width;
      const y = ((1 - this.v.y) / 2) * height;
      if (x < -it.w || x > width + it.w || y < 0 || y > height + it.h) continue;
      const d = camPos.distanceToSquared(this.v.set(spec.world[0], spec.world[1], spec.world[2]));
      cand.push({ it, x, y, opacity, rank: TIER_RANK[spec.tier] * 2 + (focused ? 0 : 1), d });
    }
    cand.sort((a, b) => a.rank - b.rank || a.d - b.d);

    const placed: { l: number; t: number; r: number; b: number }[] = [];
    const texts = new Set<string>();
    const show = new Set<LabelItem>();
    for (const c of cand) {
      if (texts.has(c.it.spec.text)) continue;
      // Anchored by its bottom centre, a few px above the point, so the label
      // sits over the place it names rather than covering it.
      const l = Math.round(c.x - c.it.w / 2);
      const t = Math.round(c.y - c.it.h - 6);
      const box = { l: l - PAD_PX, t: t - PAD_PX, r: l + c.it.w + PAD_PX, b: t + c.it.h + PAD_PX };
      if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) continue;
      placed.push(box);
      texts.add(c.it.spec.text);
      show.add(c.it);
      // Whole pixels: a fractional translate blurs text on most browsers.
      const transform = `translate(${l}px, ${t}px)`;
      const opacity = c.opacity.toFixed(2);
      if (c.it.shownTransform !== transform) {
        c.it.node.style.transform = transform;
        c.it.shownTransform = transform;
      }
      if (c.it.shownOpacity !== opacity) {
        c.it.node.style.opacity = opacity;
        c.it.shownOpacity = opacity;
      }
    }

    for (const it of this.items) {
      const want = show.has(it);
      if (want !== it.visible) {
        it.node.style.visibility = want ? "visible" : "hidden";
        it.visible = want;
      }
    }
  }

  /** Which labels are on screen right now — dev introspection. */
  visibleTexts(): string[] {
    return this.items.filter((it) => it.visible).map((it) => it.spec.text);
  }

  dispose(): void {
    this.items = [];
    this.el.remove();
  }
}
