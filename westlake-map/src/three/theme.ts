// The look of the 3D view, in one place.
//
// The governing idea: the plan scan is black ink on off-white paper, and that
// is the product's identity in 2D. So the 3D view is a white chipboard
// architectural model built on top of the actual scan — not a game level and
// not a Google-Earth mesh. Colour is spent almost nowhere, which is exactly
// why the teal route reads instantly.
//
// The two anchor colours are lifted straight from App.css so the sidebar and
// the model are visibly one product.

import * as THREE from "three";

export const PALETTE = {
  ground: 0xd4ccc1,

  slabTop: 0xffffff, // multiplier over the scan texture
  slabTopMuted: 0xcbc4ba, // a storey below the focused one
  slabEdge: 0xcfc6ba,

  wallSide: 0xe0d8cd,
  wallCap: 0xfaf7f2,
  wallEdgeLine: 0x9a8f80,

  curb: 0xb9b0a4, // below-focus storeys, unlit on purpose
  ghostLine: 0x8f8579, // above-focus perimeter
  ghostPlate: 0xffffff,

  routeCore: 0x1fbfa6, // a brightened sibling of --accent: #16776a at 3ft wide,
  routeCasing: 0xffffff, // seen from 400ft against paper, disappears
  routeHalo: 0x16776a,

  maroon: 0x7a1f2b, // --maroon, the start marker
  accent: 0x16776a, // --accent, the destination
} as const;

export interface RibbonLayer {
  width: number;
  /** Feet above the slab, along the ribbon's own normal. */
  lift: number;
  color: number;
  opacity: number;
  order: number;
}

/** Route ribbon layers, widest and lowest first. Widths mirror the 2D CSS. */
export const RIBBON: Record<"halo" | "casing" | "core", RibbonLayer> = {
  halo: { width: 11.0, lift: 0.4, color: PALETTE.routeHalo, opacity: 0.11, order: 1 },
  casing: { width: 5.0, lift: 0.55, color: PALETTE.routeCasing, opacity: 0.88, order: 2 },
  core: { width: 3.2, lift: 0.7, color: PALETTE.routeCore, opacity: 1.0, order: 3 },
};

/** Chase dashes on the core ribbon. Feet, and feet per second. */
export const DASH = { period: 9.0, on: 5.0, speed: 11.0, soften: 0.6 } as const;

export const CAMERA = {
  fov: 38, // not 50: on a 1200ft object a wide lens keystones like a cartoon
  near: 2,
  far: 6000,
  overviewDistance: 1450,
  overviewElevationDeg: 48,
  overviewAzimuthDeg: 202,
  minPolarAngle: 0.12,
  maxPolarAngle: 1.4,
  minDistance: 60,
  maxDistance: 2600,
} as const;

export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Coarse pointer ⇒ a phone or tablet: fewer pixels, no shadow map. */
export function isCoarsePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Every material the scene uses, created once and shared. Disposing is the
 * viewer's job — it walks this record, so nothing can be missed.
 */
export interface Materials {
  slab: THREE.MeshLambertMaterial;
  slabSkirt: THREE.MeshLambertMaterial;
  wallCap: THREE.MeshStandardMaterial;
  wallSide: THREE.MeshStandardMaterial;
  wallEdges: THREE.LineBasicMaterial;
  curb: THREE.MeshBasicMaterial;
  ghostLine: THREE.LineBasicMaterial;
  ghostPlate: THREE.MeshBasicMaterial;
  ground: THREE.MeshLambertMaterial;
  routeHalo: THREE.MeshBasicMaterial;
  routeCasing: THREE.MeshBasicMaterial;
  routeCore: THREE.MeshBasicMaterial;
  markerMaroon: THREE.MeshBasicMaterial;
  markerMaroonSoft: THREE.MeshBasicMaterial;
  markerAccent: THREE.MeshStandardMaterial;
  markerAccentFlat: THREE.MeshBasicMaterial;
  pulse: THREE.MeshBasicMaterial;
}

export function createMaterials(): Materials {
  // Lambert for paper: it has no specular lobe, it is cheaper across three
  // texture-heavy plates, and — the real reason — it ignores scene.environment,
  // so the scan renders at a brightness we can calibrate independently of the
  // walls.
  // DoubleSide because the exploded stack is looked at from below as well as
  // above, and because the footprint rings' winding is whatever the tracer
  // emitted — culling on it would silently drop whole wings.
  const slab = new THREE.MeshLambertMaterial({
    color: PALETTE.slabTop,
    side: THREE.DoubleSide,
  });
  const slabSkirt = new THREE.MeshLambertMaterial({
    color: PALETTE.slabEdge,
    side: THREE.DoubleSide,
  });

  // Standard for walls, because these are the only surfaces where lighting has
  // to do all the work. vertexColors carries the baked contact shading.
  const wallCap = new THREE.MeshStandardMaterial({
    color: PALETTE.wallCap,
    roughness: 0.74,
    metalness: 0,
    vertexColors: true,
  });
  const wallSide = new THREE.MeshStandardMaterial({
    color: PALETTE.wallSide,
    roughness: 0.9,
    metalness: 0,
    vertexColors: true,
    side: THREE.DoubleSide, // an interior wall is seen from both rooms
  });

  const wallEdges = new THREE.LineBasicMaterial({
    color: PALETTE.wallEdgeLine,
    transparent: true,
    opacity: 0.4,
  });

  const ribbon = (w: RibbonLayer, offset: boolean) =>
    new THREE.MeshBasicMaterial({
      color: w.color,
      transparent: true,
      opacity: w.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      // A route must never dim when it enters a shadowed corridor, so all three
      // ribbons are unlit. polygonOffset keeps long shallow runs off the slab.
      polygonOffset: offset,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

  return {
    slab,
    slabSkirt,
    wallCap,
    wallSide,
    wallEdges,
    curb: new THREE.MeshBasicMaterial({ color: PALETTE.curb }),
    ghostLine: new THREE.LineBasicMaterial({
      color: PALETTE.ghostLine,
      transparent: true,
      opacity: 0.35,
    }),
    ghostPlate: new THREE.MeshBasicMaterial({
      color: PALETTE.ghostPlate,
      transparent: true,
      opacity: 0.055,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    ground: new THREE.MeshLambertMaterial({ color: PALETTE.ground }),
    routeHalo: ribbon(RIBBON.halo, false),
    routeCasing: ribbon(RIBBON.casing, true),
    routeCore: ribbon(RIBBON.core, true),
    markerMaroon: new THREE.MeshBasicMaterial({ color: PALETTE.maroon }),
    markerMaroonSoft: new THREE.MeshBasicMaterial({
      color: PALETTE.maroon,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    }),
    // The destination is the one object allowed a little sheen, so it catches
    // the eye across the whole model.
    markerAccent: new THREE.MeshStandardMaterial({
      color: PALETTE.accent,
      roughness: 0.35,
      metalness: 0,
    }),
    markerAccentFlat: new THREE.MeshBasicMaterial({ color: PALETTE.accent }),
    pulse: new THREE.MeshBasicMaterial({
      color: PALETTE.accent,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  };
}

export function disposeMaterials(m: Materials): void {
  for (const mat of Object.values(m) as THREE.Material[]) mat.dispose();
}
