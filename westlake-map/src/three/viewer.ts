// The map: scene, the three storeys, labels, and the render loop.
//
// It is a 3D scene drawn to read as a map. It opens looking straight down,
// north up, with flat colour and screen-space labels; dragging pans, the wheel
// or a pinch zooms toward where you point, and tilting (right-drag, ctrl-drag
// or a two-finger twist, or the tilt button) leans it back to at most
// MAX_TILT_DEG, where the walls rise and the other storeys appear as ghosts.
// Flat, the walls are not extruded at all: the floor texture already draws
// them as smooth outlines, and extruded boxes seen from above are what made
// the old view read as a model.
//
// This class owns every three.js object. React never touches one — the bridge
// component creates a viewer, pushes props at it, and disposes it. That split
// is deliberate: React's reconciler and a retained-mode scene graph are two
// different ideas about who owns the tree, and mixing them is how you end up
// leaking WebGL contexts.
//
// The loop renders ON DEMAND. A static 3D map then costs zero GPU, which is
// the single largest battery win available and is why a phone can hold this
// view open through a passing period.

import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

import type { FloorData, FloorId, StairLink } from "../types";
import type { GridRoute } from "../lib/router";
import type { Directions } from "../lib/directions";
import { FLOOR_ORDER } from "../data/floors";

import {
  FLOOR_INDEX,
  MAP_ELEVATION_DEG,
  MAX_TILT_DEG,
  SPREAD,
  TILTED_ELEVATION_DEG,
  dimensionForElevation,
  ghostOpacityForDimension,
  storeyY,
  wallRiseForElevation,
} from "./units";
import { MapLabels, buildLabelItems, type MapLabelItem } from "./labels";
import { pickFloor, type FloorAnchors } from "./autoFloor";
import { buildStairColumns, type StairColumns } from "./stairColumns";
import { type PlacementSet } from "./placement";
import { buildWallGeometry, buildWallTopEdges } from "./walls";
import { buildSlabGeometry } from "./slab";
import { buildOutdoor, createAttribution, type OutdoorLayer } from "./outdoor";
import { TextureCache } from "./textures";
import { liftRoute, type Route3D } from "./routeLift";
import { buildRouteObject, type RouteObject } from "./routeObject";
import { RouteFlight, type OrbitPose } from "./flight";
import {
  CAMERA,
  FLY,
  PALETTE,
  clamp,
  createMaterials,
  disposeMaterials,
  easeInOutCubic,
  isCoarsePointer,
  prefersReducedMotion,
  type Materials,
} from "./theme";

export interface Viewer3DProps {
  floors: Record<FloorId, FloorData>;
  stairs: StairLink[];
  activeFloor: FloorId;
  /** Draw the coloured columns tying each stairwell through the storeys. */
  showStairColumns: boolean;
  /**
   * Where each storey sits. Normally straight out of align3d.json, but the
   * align editor hands in a live copy so a nudge can be seen before it is
   * proposed — there is no other way to judge a registration by eye.
   */
  placements: PlacementSet;
  route: GridRoute | null;
  /** Cheap identity for the route — rebuilding its geometry is the costly bit. */
  routeKey: string;
  directions: Directions | null;
  activeStep: number | null;
  /**
   * How many pixels of the canvas's own bottom edge the phone's bottom sheet
   * currently covers, in CSS pixels. Zero on desktop, where the panel sits
   * beside the map rather than over it. The camera still renders the full
   * canvas at the same scale; this only moves the projection centre up to
   * the middle of the strip the sheet leaves visible (clamped so that strip
   * never drops below a quarter of the canvas). Framing (`frameRoute`,
   * `resetView`) also backs the camera off so its content fits that strip.
   * A change on its own re-centres but does not reframe.
   */
  obscuredBottom: number;
  /**
   * CSS px of the canvas's left edge covered by the floating search panel on
   * a laptop. Same treatment as `obscuredBottom`, sideways: the projection
   * centre moves to the middle of what is left, and framing fits that.
   */
  obscuredLeft?: number;
}

export interface MapViewState {
  /** Leaning back from straight-down by more than a few degrees. */
  tilted: boolean;
  /** Compass heading of the top of the screen, degrees clockwise from north. */
  headingDeg: number;
}

export interface Viewer3DCallbacks {
  onPickFloor?: (f: FloorId) => void;
  /**
   * The map settled on part of the school where another floor has clearly
   * more to show than the current one. See autoFloor.ts.
   */
  onFocusFloor?: (f: FloorId) => void;
  /** A place name on the map was tapped. */
  onPickPlace?: (item: MapLabelItem) => void;
  onViewChange?: (state: MapViewState) => void;
  onFatal?: (reason: string) => void;
  /** Fly-the-route state, for the bridge's Fly / Pause / Stop buttons. */
  onFlightChange?: (state: FlightState) => void;
}

export type FlightState = "idle" | "flying" | "paused";

/** A camera move the app makes itself, eased rather than cut. */
interface CameraTween {
  from: { target: THREE.Vector3; dist: number; el: number; az: number };
  to: { target: THREE.Vector3; dist: number; el: number; az: number };
  t: number;
  duration: number;
}

interface FloorParts {
  group: THREE.Group;
  walls: THREE.Mesh;
  edges: THREE.LineSegments;
  slab: THREE.Mesh;
  skirt: THREE.Mesh;
  ghostPlate: THREE.Mesh;
  ghostOutline: THREE.LineSegments;
  slabMaterial: THREE.MeshBasicMaterial;
  /** Cloned per floor: the unfocused storeys need their own opacity. */
  wallMaterials: THREE.MeshStandardMaterial[];
  owned: Array<{ dispose(): void }>;
  /** Which resolution this floor currently holds, so it can be handed back. */
  texSize: number | null;
}

const TEX_FOCUS = 2048;
const TEX_GHOST = 1024;

export class MapViewer3D {
  private host: HTMLElement;
  private props: Viewer3DProps;
  private cb: Viewer3DCallbacks;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: MapControls;
  private materials: Materials;
  private textures: TextureCache;
  private placements: PlacementSet;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTexture: THREE.Texture | null = null;

  private floorParts = new Map<FloorId, FloorParts>();
  private outdoor: OutdoorLayer;
  private attribution: HTMLElement;
  private routeObject: RouteObject | null = null;
  private route3d: Route3D | null = null;
  private builtRouteKey = "";
  private builtRouteSpread = 0;

  private ro: ResizeObserver;
  private resizeQueued = false;
  private disposed = false;
  private dirty = true;
  private hidden = false;
  private lastTime = 0;
  private reducedMotion = prefersReducedMotion();
  private coarse = isCoarsePointer();

  /** Fixed: the stack is always open. See units.ts. */
  private readonly spread = SPREAD;
  private labels: MapLabels;
  private anchors: FloorAnchors | null = null;
  private tween: CameraTween | null = null;
  private lastViewState = "";
  /** Set by a user gesture; the floor check only answers to the user. */
  private gestureEnded = false;
  private userMoved = false;
  private floorCheckTimer = 0;
  /** The floor this viewer last asked the app for, to tell its own switches apart. */
  private requestedFloor: FloorId | null = null;
  /**
   * Where the map was when somebody chose a floor themselves (a floor chip, a
   * route). The auto selector leaves that choice alone until the map has moved
   * well away from it — otherwise tapping "Lower" over Main's busiest corridor
   * would be undone by the very next nudge.
   */
  private pinnedAt: THREE.Vector3 | null = null;
  private pointerDown: { x: number; y: number; t: number } | null = null;
  private stairColumns: StairColumns | null = null;
  private builtColumnSpread = -1;
  private builtColumnKey = "";
  /** Suppresses auto-focus while the camera is being moved by the app itself. */
  private cameraDriven = false;

  private flight: RouteFlight | null = null;
  private flightState: FlightState = "idle";
  /** How the map was tilted and turned before the flight, to frame the whole
   *  route that way again at the end rather than heading-up and leaned. */
  private beforeFlight: { el: number; az: number } | null = null;

  private onVisibility = () => {
    this.hidden = document.visibilityState === "hidden";
    this.invalidate();
  };
  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.cb.onFatal?.("The 3D view lost its graphics context.");
  };
  private invalidate = () => {
    this.dirty = true;
  };
  /**
   * The drag gesture (OrbitControls' own rotate) is the only tilt control
   * there is now, so the ghost fade — which used to answer to a slider —
   * has to be recomputed on every camera change, not just when the active
   * floor or the alignment changes. Cheap: a handful of material properties,
   * no allocation, and it only runs while the camera is actually moving.
   */
  private onOrbitChange = () => {
    this.applyFloorStates();
    this.invalidate();
    this.reportViewState();
    if (this.userMoved && !this.tween && !this.cameraDriven) {
      window.clearTimeout(this.floorCheckTimer);
      this.floorCheckTimer = window.setTimeout(this.checkFloorFromView, 260);
    }
  };
  private onGestureStart = () => {
    this.tween = null; // a finger on the map always beats an animation
    // A flight too: the camera stays exactly where it was grabbed. The flight
    // keeps inside the controls' own limits, so handing it over never jumps.
    if (this.flight) this.endFlight(false);
    this.userMoved = true;
    this.gestureEnded = false;
  };
  private onGestureEnd = () => {
    this.gestureEnded = true;
  };
  private onPointerDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  /** A tap (not a drag) on a place name picks that place. */
  private onPointerUp = (e: PointerEvent) => {
    const d = this.pointerDown;
    this.pointerDown = null;
    if (!d || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 500) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.labels.hitTest(e.clientX - rect.left, e.clientY - rect.top, this.coarse ? 16 : 8);
    if (hit) this.cb.onPickPlace?.(hit);
  };

  constructor(host: HTMLElement, props: Viewer3DProps, cb: Viewer3DCallbacks) {
    this.host = host;
    this.props = props;
    this.cb = cb;
    this.placements = props.placements;

    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.coarse, // on phones the pixel ratio buys more than MSAA
      alpha: true,
      stencil: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.coarse ? 1.75 : 2));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearAlpha(0); // the backdrop gradient is CSS on the host div
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral, not ACES: ACES pushes near-whites toward cream and desaturates,
    // and this entire scene is near-white paper.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // No shadows: a map is lit evenly. Shadows were the single strongest cue
    // that this was a model on a table.
    this.renderer.shadowMap.enabled = false;
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, w / h, CAMERA.near, CAMERA.far);
    this.materials = createMaterials();
    this.textures = new TextureCache(this.renderer);

    // Map controls: one-finger / left drag pans across the floor, the wheel and
    // a pinch zoom toward the pointer, right-drag (or ctrl/shift-drag) and a
    // two-finger twist rotate and tilt. Panning stays on the floor's own plane,
    // so the map slides under the pointer the way a map does.
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = (MAX_TILT_DEG * Math.PI) / 180;
    this.controls.minDistance = CAMERA.minDistance;
    this.controls.maxDistance = CAMERA.maxDistance;
    this.controls.zoomToCursor = true;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 1.1;
    this.controls.panSpeed = 1;
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.addEventListener("change", this.onOrbitChange);
    this.controls.addEventListener("start", this.onGestureStart);
    this.controls.addEventListener("end", this.onGestureEnd);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);

    this.labels = new MapLabels(host);

    this.setupLights();
    this.scene.background = new THREE.Color(PALETTE.ground);

    this.outdoor = buildOutdoor();
    this.scene.add(this.outdoor.group);
    this.attribution = createAttribution(host);

    for (const f of FLOOR_ORDER) this.ensureFloor(f);
    this.syncLabels();
    this.applyFloorStates();
    this.syncStairColumns();
    this.syncRoute();
    this.applyViewOffset(w, h);
    this.resetView(); // after the floors, so it can frame the real model

    this.ro = new ResizeObserver(() => this.queueResize());
    this.ro.observe(host);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.renderer.domElement.addEventListener("webglcontextlost", this.onContextLost);

    this.renderer.setAnimationLoop(this.tick);

    // A handle for poking at the scene from the console while developing.
    if (import.meta.env.DEV) {
      (window as unknown as { __viewer?: MapViewer3D }).__viewer = this;
    }
  }

  /** Dev-only: park the camera at a chosen framing, for screenshots. */
  debugCamera(dist: number, elevDeg: number, azDeg: number, target?: [number, number, number]): void {
    const c = target ? new THREE.Vector3(...target) : this.modelCentre();
    this.placeCamera(c, dist, elevDeg, azDeg);
    this.renderer.render(this.scene, this.camera);
  }

  /** Dev-only introspection for the console. */
  debugInfo(): unknown {
    const out: Record<string, unknown> = {
      spread: this.spread,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      textures: this.renderer.info.memory.textures,
      geometries: this.renderer.info.memory.geometries,
      cameraPos: this.camera.position.toArray().map((n) => Math.round(n)),
      target: this.controls.target.toArray().map((n) => Math.round(n)),
    };
    for (const [floor, parts] of this.floorParts) {
      const bb = parts.slab.geometry.boundingSphere;
      out[floor] = {
        y: Math.round(parts.group.position.y),
        slabVisible: parts.slab.visible,
        wallsVisible: parts.walls.visible,
        hasTexture: Boolean(parts.slabMaterial.map),
        slabRadius: bb ? Math.round(bb.radius) : null,
        slabCentre: bb ? bb.center.toArray().map((n) => Math.round(n)) : null,
      };
    }
    return out;
  }

  // ---------------------------------------------------------------- scene

  private setupLights(): void {
    const C = new THREE.Vector3(0, 0, 0);
    const R = 760;

    // A white model lit by one white light is grey and dead. Warm key + cool
    // fill is the oldest trick in architectural rendering and costs one extra
    // light with no shadow map.
    const key = new THREE.DirectionalLight(0xfff6e8, 2.2);
    key.position.copy(C).add(new THREE.Vector3(-0.55, 0.72, 0.42).normalize().multiplyScalar(900));
    key.target.position.copy(C);
    key.castShadow = false;
    key.shadow.mapSize.set(2048, 2048);
    const s = R * 0.68;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.camera.near = 200;
    key.shadow.camera.far = 1900;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.5; // world units are feet
    key.shadow.radius = 3;
    this.scene.add(key, key.target);

    const fill = new THREE.DirectionalLight(0xdfe8f2, 0.45);
    fill.position.copy(C).add(new THREE.Vector3(0.6, 0.35, -0.7).normalize().multiplyScalar(900));
    this.scene.add(fill);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc9bcab, 0.55));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    // A soft sky-to-ground gradient across every wall face, for free. Most of
    // the difference between "modelled" and "default three.js demo".
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTexture = this.pmrem.fromScene(room, 0.04).texture;
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.35;
    room.dispose?.();
  }

  private ensureFloor(floor: FloorId): FloorParts {
    const existing = this.floorParts.get(floor);
    if (existing) return existing;

    const p = this.placements[floor];
    const owned: Array<{ dispose(): void }> = [];
    const group = new THREE.Group();
    group.name = `floor-${floor}`;

    const { geometry: wallGeom, stats } = buildWallGeometry(floor, p);
    owned.push(wallGeom);
    const wallMaterials = [this.materials.wallCap.clone(), this.materials.wallSide.clone()];
    owned.push(...wallMaterials);
    const walls = new THREE.Mesh(wallGeom, wallMaterials);
    group.add(walls);

    const edgeGeom = buildWallTopEdges(floor, p);
    owned.push(edgeGeom);
    const edges = new THREE.LineSegments(edgeGeom, this.materials.wallEdges);
    group.add(edges);

    const { top, skirt } = buildSlabGeometry(floor, p);
    owned.push(top, skirt);
    if (import.meta.env.DEV) {
      const bb = wallGeom.boundingSphere;
      console.log(
        `[3d] ${floor}: walls ${stats.totalTris} tris in ${stats.buildMs.toFixed(0)}ms ` +
          `(caps ${stats.capTris} / sides ${stats.sideTris}), ` +
          `slab verts ${top.getAttribute("position")?.count ?? 0}, ` +
          `skirt verts ${skirt.getAttribute("position")?.count ?? 0}, ` +
          `radius ${bb ? bb.radius.toFixed(0) : "?"}ft`
      );
    }
    // Each floor owns its slab material because the texture and the muted
    // tint are per-floor state.
    const slabMaterial = this.materials.slab.clone();
    owned.push(slabMaterial);
    const slab = new THREE.Mesh(top, slabMaterial);
    group.add(slab);

    const skirtMesh = new THREE.Mesh(skirt, this.materials.slabSkirt);
    group.add(skirtMesh);

    // A storey above the focused one is replaced by a glass plate plus its
    // outline: it keeps a body without hiding anything below it.
    const ghostPlate = new THREE.Mesh(top, this.materials.ghostPlate);
    ghostPlate.renderOrder = 3;
    ghostPlate.visible = false;
    group.add(ghostPlate);

    const outlineGeom = new THREE.EdgesGeometry(top, 20);
    owned.push(outlineGeom);
    const ghostOutline = new THREE.LineSegments(outlineGeom, this.materials.ghostLine);
    ghostOutline.visible = false;
    group.add(ghostOutline);

    this.scene.add(group);
    const parts: FloorParts = {
      group,
      walls,
      edges,
      slab,
      skirt: skirtMesh,
      ghostPlate,
      ghostOutline,
      slabMaterial,
      wallMaterials,
      owned,
      texSize: null,
    };
    this.floorParts.set(floor, parts);
    void this.loadFloorTexture(floor);
    return parts;
  }

  private async loadFloorTexture(floor: FloorId): Promise<void> {
    const parts = this.floorParts.get(floor);
    if (!parts) return;
    // Only the storey the user is actually reading gets the high-resolution
    // page; three of those at once is enough VRAM to lose the context on a
    // mid-range phone. "All" is emphatically not an excuse to promote all
    // three — it is the mode most likely to be open on a phone.
    const focused = this.props.activeFloor === floor;
    const size = focused ? TEX_FOCUS : TEX_GHOST;
    if (parts.texSize === size) return;
    const previous = parts.texSize;
    try {
      const tex = await this.textures.load(floor, size);
      if (this.disposed) return;
      parts.slabMaterial.map = tex;
      parts.slabMaterial.needsUpdate = true;
      parts.texSize = size;
      if (previous !== null && previous !== size) this.textures.release(floor, previous);
      this.invalidate();
    } catch {
      // A missing texture is survivable — the model still reads. Leave the
      // slab flat rather than failing the whole view.
    }
  }

  // ------------------------------------------------------------ floor state

  private applyFloorStates(): void {
    const activeIdx = FLOOR_INDEX[this.props.activeFloor];
    // Looking straight down, the storeys are all at the same height, so the
    // unfocused ones would sit exactly on top of the one being read and turn
    // it to mush. They fade out as the camera flattens toward plan, which is
    // also what makes "flat" read as a plan of ONE floor rather than a bad 3D
    // view — and back in the moment the drag tilts away from it, since this
    // is read straight off the camera's own elevation now.
    const elev = this.currentElevationDeg();
    const ghost = ghostOpacityForDimension(dimensionForElevation(elev));
    // Flat, there are no extruded walls at all — the plate draws them. They
    // grow out of the floor as the view tilts, which is what tells you the
    // tilt did something, and never get taller than a low partition: this is
    // a map you can lean, not a model you walk around.
    const rise = wallRiseForElevation(elev);

    // The streets and fields follow the storey being read, a foot under its
    // slab, so every floor is seen in its surroundings and the slab covers
    // the building's own outline.
    this.outdoor.group.position.y = storeyY(this.props.activeFloor, this.spread) - 1;

    // Tilted, the storeys below the one being read show through as faint
    // plates, so you can see there is more building under you. The ones above
    // stay hidden: they sit between the camera and the floor you are reading,
    // and a map you have to read through another map is not a map. Ghosts get
    // no walls either — a ghost is a footprint, not a second model.
    for (const floor of FLOOR_ORDER) {
      const parts = this.floorParts.get(floor);
      if (!parts) continue;
      const focus = FLOOR_INDEX[floor] === activeIdx;
      parts.group.position.y = storeyY(floor, this.spread);

      parts.ghostPlate.visible = false;
      parts.ghostOutline.visible = false;

      const above = FLOOR_INDEX[floor] > activeIdx;
      const hidden = !focus && (ghost < 0.02 || above);
      const wallsUp = focus && rise > 0.02;
      parts.walls.scale.y = Math.max(rise, 0.001);
      parts.edges.scale.y = Math.max(rise, 0.001);
      parts.edges.visible = focus && wallsUp;
      parts.walls.visible = !hidden && wallsUp;
      parts.slab.visible = !hidden;
      parts.skirt.visible = !hidden;

      parts.slabMaterial.color.setHex(focus ? 0xffffff : 0xcfc9c0);
      parts.slabMaterial.opacity = focus ? 1 : ghost;
      parts.slabMaterial.transparent = !focus;
      parts.slabMaterial.depthWrite = focus;
      parts.slabMaterial.needsUpdate = true;

      for (const m of parts.wallMaterials) {
        m.opacity = focus ? 1 : ghost * 0.72;
        m.transparent = !focus;
        m.depthWrite = focus;
        m.needsUpdate = true;
      }

      parts.walls.renderOrder = focus ? 0 : -1;
      parts.slab.renderOrder = focus ? 0 : -1;
    }
  }

  /**
   * Rebuild every storey against a changed alignment.
   *
   * The wall and slab geometry is baked with the placement applied, so moving a
   * storey means rebuilding it. That is heavier than transforming a group, and
   * it is the right trade here: alignment only changes while a human is dragging
   * the nudge buttons in the editor, a few times a second at worst, and keeping
   * one code path for "where is this storey" is worth far more than the frames.
   */
  private rebuildForAlignment(): void {
    for (const [floor, parts] of this.floorParts) {
      this.scene.remove(parts.group);
      for (const o of parts.owned) o.dispose();
      if (parts.texSize !== null) this.textures.release(floor, parts.texSize);
    }
    this.floorParts.clear();
    for (const f of FLOOR_ORDER) this.ensureFloor(f);
    this.syncLabels();
    this.applyFloorStates();
    for (const f of FLOOR_ORDER) void this.loadFloorTexture(f);
    this.builtColumnSpread = -1;
    this.syncStairColumns();
    this.builtRouteKey = "";
    this.syncRoute();
    this.invalidate();
  }

  // ----------------------------------------------------- focus & vertical

  /**
   * The camera's actual elevation above the horizon, in degrees, computed
   * from where it currently sits relative to the orbit target — not from any
   * stored number, because there isn't one any more. 90 is looking straight
   * down; 0 would be looking dead level.
   */
  private currentElevationDeg(): number {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const horiz = Math.hypot(offset.x, offset.z);
    if (horiz < 1e-6 && Math.abs(offset.y) < 1e-6) return MAP_ELEVATION_DEG; // not placed yet
    return (Math.atan2(offset.y, horiz) * 180) / Math.PI;
  }

  /** Compass heading of the top of the screen, degrees clockwise from north. */
  private currentAzimuthDeg(): number {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    return (Math.atan2(offset.x, offset.z) * 180) / Math.PI;
  }

  private cameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Screen pixels per foot at the middle of the view. */
  private pxPerFoot(): number {
    const h = Math.max(1, this.host.clientHeight);
    return h / (2 * this.cameraDistance() * Math.tan((CAMERA.fov * Math.PI) / 360));
  }

  private reportViewState(): void {
    if (!this.cb.onViewChange) return;
    const tilted = this.currentElevationDeg() < MAP_ELEVATION_DEG - 4;
    // Heading of the screen's top edge. The camera sits on the far side of
    // the target from where it looks, so it is the camera's azimuth + 180.
    let heading = Math.round(-this.currentAzimuthDeg());
    heading = ((heading % 360) + 360) % 360;
    const key = `${tilted}:${heading}`;
    if (key === this.lastViewState) return;
    this.lastViewState = key;
    this.cb.onViewChange({ tilted, headingDeg: heading });
  }

  /**
   * The auto floor selector. Once a pan or zoom settles, ask autoFloor.ts
   * whether another storey has clearly more going on under the middle of the
   * view than the one being shown, and if so, switch to it.
   */
  private checkFloorFromView = () => {
    if (this.disposed || this.cameraDriven || this.tween || !this.anchors) return;
    if (!this.gestureEnded) return; // still being dragged; damping will call back
    this.userMoved = false;
    this.gestureEnded = false;
    // The circle that counts as "where you are looking": a bit under half the
    // visible height. Zoomed right out to the whole school there is nothing
    // to infer — every floor is in view — so leave the choice alone.
    const visibleHalf = this.cameraDistance() * Math.tan((CAMERA.fov * Math.PI) / 360) * this.visibleFraction();
    if (visibleHalf > 520) return;
    const radius = clamp(visibleHalf * 0.45, 30, 200);
    const t = this.controls.target;
    if (this.pinnedAt) {
      const dx = t.x - this.pinnedAt.x;
      const dz = t.z - this.pinnedAt.z;
      if (Math.hypot(dx, dz) < Math.max(160, radius * 2)) return;
      this.pinnedAt = null;
    }
    const next = pickFloor(this.anchors, FLOOR_ORDER, this.props.activeFloor, t.x, t.z, radius);
    if (next !== this.props.activeFloor) {
      this.requestedFloor = next;
      this.cb.onFocusFloor?.(next);
    }
  };

  /** Place names and the auto-floor anchors, both from the same points. */
  private syncLabels(): void {
    const items = buildLabelItems(this.props.floors, this.placements, this.spread);
    const anchors = {} as Record<FloorId, number[]>;
    for (const f of FLOOR_ORDER) anchors[f] = [];
    // Anchors before the outdoor names go in: autoFloor counts the school's
    // places, and a street name is on every floor at once.
    for (const it of items) anchors[it.floor].push(it.world.x, it.world.z);
    for (const f of FLOOR_ORDER) {
      const y = storeyY(f, this.spread);
      this.outdoor.labels.forEach((l, i) =>
        items.push({
          key: `${f}:outdoor:${i}`,
          floor: f,
          id: "",
          text: l.text,
          kind: l.kind === "road" ? "street" : "ground",
          world: new THREE.Vector3(l.x, y, l.z),
        })
      );
    }
    this.labels.setItems(items);
    this.labels.setFloor(this.props.activeFloor);
    this.anchors = {
      lower: new Float32Array(anchors.lower),
      main: new Float32Array(anchors.main),
      upper: new Float32Array(anchors.upper),
    };
    this.invalidate();
  }

  // ------------------------------------------------------------ map buttons

  /** Zoom in (factor < 1) or out (> 1) about the middle of the view. */
  zoomBy(factor: number): void {
    const dist = clamp(this.cameraDistance() * factor, CAMERA.minDistance, CAMERA.maxDistance);
    this.animateTo(this.controls.target.clone(), dist, this.currentElevationDeg(), this.currentAzimuthDeg(), 260);
    this.userMoved = true;
    this.gestureEnded = true;
  }

  /** Turn back to north-up, keeping zoom and tilt. */
  resetNorth(): void {
    this.animateTo(this.controls.target.clone(), this.cameraDistance(), this.currentElevationDeg(), 0, 420);
  }

  /** Lean the map back, or flatten it again. */
  toggleTilt(): void {
    const flat = this.currentElevationDeg() >= MAP_ELEVATION_DEG - 4;
    this.animateTo(
      this.controls.target.clone(),
      this.cameraDistance(),
      flat ? TILTED_ELEVATION_DEG : MAP_ELEVATION_DEG,
      this.currentAzimuthDeg(),
      520
    );
  }

  private animateTo(target: THREE.Vector3, dist: number, el: number, az: number, ms: number): void {
    if (this.reducedMotion || ms <= 0) {
      this.tween = null;
      this.placeCamera(target, dist, el, az);
      return;
    }
    // Turn the short way round.
    const fromAz = this.currentAzimuthDeg();
    let toAz = az;
    while (toAz - fromAz > 180) toAz -= 360;
    while (toAz - fromAz < -180) toAz += 360;
    this.tween = {
      from: {
        target: this.controls.target.clone(),
        dist: this.cameraDistance(),
        el: this.currentElevationDeg(),
        az: fromAz,
      },
      to: { target: target.clone(), dist, el, az: toAz },
      t: 0,
      duration: ms / 1000,
    };
    this.invalidate();
  }

  private stepTween(dt: number): void {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + dt / tw.duration);
    const k = easeInOutCubic(tw.t);
    const lerp = (a: number, b: number) => a + (b - a) * k;
    const target = tw.from.target.clone().lerp(tw.to.target, k);
    // Always on the floor being shown, even if the floor changed mid-flight.
    target.y = storeyY(this.props.activeFloor, this.spread);
    // Distance eases in log space, so a big zoom does not rush the first half.
    const dist = Math.exp(lerp(Math.log(tw.from.dist), Math.log(tw.to.dist)));
    this.cameraDriven = true;
    this.placeCamera(target, dist, lerp(tw.from.el, tw.to.el), lerp(tw.from.az, tw.to.az));
    this.cameraDriven = false;
    if (tw.t >= 1) {
      this.tween = null;
      if (this.userMoved && this.gestureEnded) this.checkFloorFromView();
    }
  }

  /** Move the orbit target onto a storey, so "focus" and "look at" agree. */
  private lookAtFloor(floor: FloorId): void {
    const y = storeyY(floor, this.spread);
    const target = this.controls.target;
    if (Math.abs(target.y - y) < 0.5) return;
    const dy = y - target.y;
    this.cameraDriven = true;
    target.y = y;
    this.camera.position.y += dy;
    this.controls.update();
    this.cameraDriven = false;
    this.invalidate();
  }

  /**
   * Rebuild the stairwell columns. Cheap enough to redo whenever the stack
   * moves, and it has to be: the columns only mean anything if their ends stay
   * pinned to the storeys they connect.
   */
  private syncStairColumns(): void {
    const key = this.props.stairs
      .map((s) => `${s.id}:${s.verified ? 1 : 0}:${Object.values(s.points).join(",")}`)
      .join("|");
    const wanted = this.props.showStairColumns;
    const spreadMoved = Math.abs(this.builtColumnSpread - this.spread) > 0.5;
    if (this.stairColumns && wanted && key === this.builtColumnKey && !spreadMoved) return;

    if (this.stairColumns) {
      this.scene.remove(this.stairColumns.group);
      this.stairColumns.dispose();
      this.stairColumns = null;
    }
    this.builtColumnKey = key;
    this.builtColumnSpread = this.spread;
    if (!wanted) {
      this.invalidate();
      return;
    }
    // At the flat end there is no vertical to show, so the columns would be a
    // pile of discs on one plane. Fade them in with the stack.
    const opacity = Math.min(1, Math.max(0, (this.spread - 4) / 20));
    if (opacity <= 0.01) {
      this.invalidate();
      return;
    }
    this.stairColumns = buildStairColumns(
      this.props.stairs,
      this.props.floors,
      this.placements,
      this.spread,
      { opacity }
    );
    this.scene.add(this.stairColumns.group);
    this.invalidate();
  }

  /** What the app should say about the vertical ties it is drawing. */
  stairColumnStats(): { drawn: number; guessed: number } {
    return this.stairColumns?.stats ?? { drawn: 0, guessed: 0 };
  }

  // ----------------------------------------------------------------- route

  private syncRoute(): void {
    const { route, routeKey, directions } = this.props;
    const spreadChanged = Math.abs(this.builtRouteSpread - this.spread) > 0.5;
    if (route && routeKey === this.builtRouteKey && !spreadChanged) return;

    // The flight holds the old spine; following it now would fly a route that
    // is no longer drawn. Whatever replaced it reframes the camera itself.
    if (this.flight) this.endFlight(false);
    if (this.routeObject) {
      this.scene.remove(this.routeObject.group);
      this.routeObject.dispose();
      this.routeObject = null;
      this.route3d = null;
    }
    this.builtRouteKey = route ? routeKey : "";
    this.builtRouteSpread = this.spread;
    if (!route || route.legs.length === 0) {
      this.invalidate();
      return;
    }

    this.route3d = liftRoute(route, this.placements, this.spread, directions);
    this.routeObject = buildRouteObject(this.route3d, {
      materials: this.materials,
      reducedMotion: this.reducedMotion,
      spread: this.spread,
    });
    this.scene.add(this.routeObject.group);
    this.invalidate();
  }

  /** Frame the whole route, or the building when there isn't one. */
  frameRoute(
    el = this.currentElevationDeg(),
    az = this.currentAzimuthDeg(),
    ms = 650
  ): void {
    if (!this.route3d) {
      this.resetView();
      return;
    }
    // Framed on the plan extent, at the height of the floor being shown, and
    // from wherever the user has the map turned and tilted — a map that snaps
    // back to north-up every time you ask for directions is fighting you.
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const pts = this.route3d.points;
    for (let i = 0; i < pts.length; i += 3) box.expandByPoint(v.set(pts[i], 0, pts[i + 2]));
    const centre = box.getCenter(new THREE.Vector3());
    centre.y = storeyY(this.props.activeFloor, this.spread);
    const size = box.getSize(new THREE.Vector3());
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const halfFov = Math.tan((CAMERA.fov * Math.PI) / 360);
    const fitH = (size.z * 0.5 + 90) / halfFov / this.visibleFraction();
    const fitW = (size.x * 0.5 + 90) / halfFov / ((w / h) * this.visibleWidthFraction(w));
    const dist = clamp(Math.max(fitH, fitW), CAMERA.minDistance * 3, CAMERA.maxDistance);
    this.animateTo(centre, dist, el, az, ms);
  }

  /** The centre of the built model, not the page origin — the building only
   *  occupies part of its sheet, so those are tens of feet apart. */
  private modelCentre(): THREE.Vector3 {
    const parts = this.floorParts.get("main") ?? this.floorParts.values().next().value;
    const sphere = parts?.walls.geometry.boundingSphere;
    const c = sphere ? sphere.center.clone() : new THREE.Vector3();
    c.y = storeyY(this.props.activeFloor, this.spread);
    return c;
  }

  resetView(): void {
    // Straight down and north up: the whole school, filling the screen the
    // way a map opens on the place you searched for. Fitted on the plan's
    // bounding box, not a sphere round it — the building is far wider than
    // it is tall, and a sphere leaves it a strip across the middle.
    // Every storey, because Upper's west wing and Lower's south-east reach
    // past Main's walls.
    const box = new THREE.Box3();
    for (const parts of this.floorParts.values()) {
      const g = parts.slab.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (g.boundingBox) box.union(g.boundingBox);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-600, 0, -450), new THREE.Vector3(600, 0, 450));
    const c = box.getCenter(new THREE.Vector3());
    c.y = storeyY(this.props.activeFloor, this.spread);
    const size = box.getSize(new THREE.Vector3());
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const halfFov = Math.tan((CAMERA.fov * Math.PI) / 360);
    const fit = Math.max(
      (size.z * 0.5 * 1.02) / halfFov / this.visibleFraction(),
      (size.x * 0.5 * 1.02) / halfFov / ((w / h) * this.visibleWidthFraction(w))
    );
    const dist = clamp(fit, CAMERA.minDistance, CAMERA.maxDistance);
    this.placeCamera(c, dist, MAP_ELEVATION_DEG, 0);
  }

  /**
   * The share of the canvas height left visible above the bottom sheet, in
   * (0.25, 1]. The one place `obscuredBottom` is clamped, so the view offset
   * and the framing distance can never disagree about the strip's size.
   */
  private visibleFraction(h = Math.max(1, this.host.clientHeight)): number {
    const raw = this.props.obscuredBottom;
    // Keep at least a quarter of the canvas: past that the strip is too thin to frame into.
    const obscured = Math.min(Math.max(0, Number.isFinite(raw) ? raw : 0), h * 0.75);
    return (h - obscured) / h;
  }

  /** The share of the canvas width left visible beside the panel, in [0.4, 1]. */
  private visibleWidthFraction(w = Math.max(1, this.host.clientWidth)): number {
    const raw = this.props.obscuredLeft ?? 0;
    const obscured = Math.min(Math.max(0, Number.isFinite(raw) ? raw : 0), w * 0.6);
    return (w - obscured) / w;
  }

  /**
   * Centre the projection on the strip that isn't behind the bottom sheet,
   * without touching the camera's position, target or scale.
   *
   * The virtual sensor is the canvas's own size, and the rendered window is
   * slid down it by half the obscured height. That puts the principal point
   * at (h - obscured) / 2 from the top of the canvas — the middle of the
   * visible strip — while the fov and aspect stay those of the real canvas,
   * so opening the sheet moves the picture up and never zooms it. (A taller
   * sensor would change `aspect` and magnify by (h + obscured) / h.)
   */
  private applyViewOffset(
    w = Math.max(1, this.host.clientWidth),
    h = Math.max(1, this.host.clientHeight)
  ): void {
    const obscured = h * (1 - this.visibleFraction(h));
    const left = w * (1 - this.visibleWidthFraction(w));
    if (obscured < 1 && left < 1) {
      // clearViewOffset() leaves `aspect` as the last offset set it; restore it
      // first so its own updateProjectionMatrix() uses the real one.
      this.camera.aspect = w / h;
      this.camera.clearViewOffset();
    } else {
      // setViewOffset sets aspect = w / h and updates the projection itself.
      this.camera.setViewOffset(w, h, -left / 2, obscured / 2, w, h);
    }
  }

  private placeCamera(target: THREE.Vector3, dist: number, elevDeg: number, azDeg: number): void {
    const el = (elevDeg * Math.PI) / 180;
    const az = (azDeg * Math.PI) / 180;
    this.controls.target.copy(target);
    this.camera.position.set(
      target.x + dist * Math.cos(el) * Math.sin(az),
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.cos(az)
    );
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  // ---------------------------------------------------------------- flight

  /**
   * Fly the current route: heading-up and leaned back, the camera follows the
   * walk from start to end, climbing or dropping with it on the stairs while
   * the floor switches under it (see `FLY` in theme.ts and flight.ts). Any
   * touch on the map takes the camera back; Stop, or arriving, glides out to
   * the whole route.
   *
   * With reduced motion it does not glide: it cuts from one direction step to
   * the next, holding each, and cuts back to the overview at the end.
   */
  startFlight(): void {
    if (this.disposed || !this.route3d || this.route3d.totalFt <= 0) return;
    this.tween = null;
    window.clearTimeout(this.floorCheckTimer);
    this.userMoved = false; // the floor follows the flight, not the view
    if (!this.flight) {
      this.beforeFlight = { el: this.currentElevationDeg(), az: this.currentAzimuthDeg() };
    }
    this.flight = new RouteFlight(this.route3d, this.currentPose(), this.reducedMotion);
    this.setFlightState("flying");
    this.invalidate();
  }

  pauseFlight(): void {
    if (this.flight && this.flightState === "flying") this.setFlightState("paused");
  }

  resumeFlight(): void {
    if (this.flight && this.flightState === "paused") this.setFlightState("flying");
  }

  /** Stop and show the whole route again — the Stop button, as opposed to a
   *  drag, which leaves the camera where it is. */
  stopFlight(): void {
    if (this.flight) this.endFlight(true);
  }

  private endFlight(reframe: boolean): void {
    this.flight = null;
    this.setFlightState("idle");
    const before = this.beforeFlight;
    this.beforeFlight = null;
    if (reframe && before) this.frameRoute(before.el, before.az, FLY.outroMs);
  }

  private setFlightState(state: FlightState): void {
    if (state === this.flightState) return;
    this.flightState = state;
    this.cb.onFlightChange?.(state);
  }

  private currentPose(): OrbitPose {
    return {
      target: this.controls.target.clone(),
      dist: this.cameraDistance(),
      el: this.currentElevationDeg(),
      az: this.currentAzimuthDeg(),
    };
  }

  private stepFlight(dt: number): void {
    const flight = this.flight;
    if (!flight) return;
    const pose = flight.step(dt);
    this.cameraDriven = true;
    this.placeCamera(pose.target, pose.dist, pose.el, pose.az);
    this.cameraDriven = false;

    // The floor being read is the one the route is on, switching halfway up
    // (or down) the stairs: by then the ribbon is closer to the next storey
    // than the last, and the next one's names are the ones coming up.
    const idx = Math.round(flight.floorIndex());
    const floor = FLOOR_ORDER.find((f) => FLOOR_INDEX[f] === idx);
    if (floor && floor !== this.props.activeFloor && floor !== this.requestedFloor) {
      this.requestedFloor = floor; // asked for by the viewer, so not a pin
      this.cb.onFocusFloor?.(floor);
    }
    if (flight.done) this.endFlight(true);
  }

  // ------------------------------------------------------------- lifecycle

  update(next: Viewer3DProps): void {
    if (this.disposed) return;
    const prev = this.props;
    this.props = next;

    if (prev.placements !== next.placements) {
      this.placements = next.placements;
      // Re-registering a storey moves every wall, slab and stair column on it.
      this.rebuildForAlignment();
    }

    if (prev.floors !== next.floors) this.syncLabels();

    const floorChanged = prev.activeFloor !== next.activeFloor;
    if (floorChanged) {
      // Not one this viewer asked for, so a person (or a route) chose it.
      this.pinnedAt = next.activeFloor === this.requestedFloor ? null : this.controls.target.clone();
      this.requestedFloor = null;
      this.labels.setFloor(next.activeFloor);
      this.applyFloorStates();
      // In flight the floor follows the camera, not the other way round.
      if (!this.flight) this.lookAtFloor(next.activeFloor);
      for (const f of FLOOR_ORDER) void this.loadFloorTexture(f);
      this.invalidate();
    }

    if (prev.showStairColumns !== next.showStairColumns || prev.stairs !== next.stairs) {
      this.syncStairColumns();
    }
    if (prev.routeKey !== next.routeKey) {
      this.syncRoute();
      this.applyFloorStates();
      this.frameRoute();
    }

    if (prev.obscuredBottom !== next.obscuredBottom || prev.obscuredLeft !== next.obscuredLeft) {
      this.applyViewOffset();
      this.invalidate();
    }
  }

  private queueResize(): void {
    if (this.resizeQueued || this.disposed) return;
    this.resizeQueued = true;
    requestAnimationFrame(() => {
      this.resizeQueued = false;
      if (this.disposed) return;
      const w = this.host.clientWidth;
      const h = this.host.clientHeight;
      if (w === 0 || h === 0) return; // the bottom sheet is mid-transition
      this.renderer.setSize(w, h, false);
      this.applyViewOffset(w, h);
      this.invalidate();
    });
  }

  private tick = (time: number) => {
    if (this.disposed || this.hidden) return;
    const dt = this.lastTime ? Math.min(0.05, (time - this.lastTime) / 1000) : 0;
    this.lastTime = time;

    const animating = this.routeObject !== null && !this.reducedMotion;
    if (animating) this.routeObject?.update(dt);
    if (this.tween) this.stepTween(dt || 1 / 60);
    if (this.flight && this.flightState === "flying") this.stepFlight(dt || 1 / 60);

    // controls.update() returns true while damping is still settling. The
    // previous guard tested `enableDamping`, which is a constant true, so the
    // early-out could never fire and a still scene redrew every frame — the
    // whole point of rendering on demand.
    const settling = this.controls.update();
    if (!this.dirty && !animating && !settling) return;

    this.renderer.render(this.scene, this.camera);
    this.labels.layout(
      this.camera,
      Math.max(1, this.host.clientWidth),
      Math.max(1, this.host.clientHeight),
      this.pxPerFoot(),
      false
    );
    this.dirty = false;
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost);
    window.clearTimeout(this.floorCheckTimer);
    this.controls.removeEventListener("change", this.onOrbitChange);
    this.controls.removeEventListener("start", this.onGestureStart);
    this.controls.removeEventListener("end", this.onGestureEnd);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.controls.dispose();
    this.labels.dispose();
    this.attribution.remove();
    this.flight = null;

    if (this.routeObject) {
      this.scene.remove(this.routeObject.group);
      this.routeObject.dispose();
      this.routeObject = null;
    }
    if (this.stairColumns) {
      this.scene.remove(this.stairColumns.group);
      this.stairColumns.dispose();
      this.stairColumns = null;
    }
    this.scene.background = null;
    this.scene.remove(this.outdoor.group);
    this.outdoor.dispose();
    for (const parts of this.floorParts.values()) {
      this.scene.remove(parts.group);
      for (const o of parts.owned) o.dispose();
    }
    this.floorParts.clear();

    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    disposeMaterials(this.materials);
    this.textures.disposeAll();
    this.envTexture?.dispose();
    this.pmrem?.dispose();
    this.scene.environment = null;

    this.renderer.dispose();
    this.renderer.forceContextLoss();
    if (this.renderer.domElement.parentNode === this.host) {
      this.host.removeChild(this.renderer.domElement);
    }
  }
}
