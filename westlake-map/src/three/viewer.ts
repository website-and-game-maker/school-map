// The 3D view: scene, lighting, the three storeys, and the render loop.
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
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

import type { FloorData, FloorId, StairLink } from "../types";
import type { GridRoute } from "../lib/router";
import type { Directions } from "../lib/directions";
import { FLOOR_ORDER } from "../data/floors";

import {
  DEFAULT_ELEVATION_DEG,
  FLOOR_INDEX,
  GHOST_WALL_FACTOR,
  SPREAD,
  dimensionForElevation,
  ghostOpacityForDimension,
  storeyY,
} from "./units";
import { buildApron, buildSite, type Site } from "./site";
import { buildStairColumns, type StairColumns } from "./stairColumns";
import { type PlacementSet } from "./placement";
import { buildWallGeometry, buildWallTopEdges } from "./walls";
import { buildSlabGeometry } from "./slab";
import { TextureCache } from "./textures";
import { liftRoute, type Route3D } from "./routeLift";
import { buildRouteObject, type RouteObject } from "./routeObject";
import { RouteFlight, type FlightPose } from "./flight";
import { LabelLayer, labelSpecs } from "./labels";
import {
  CAMERA,
  FLY,
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
}

export interface Viewer3DCallbacks {
  onPickFloor?: (f: FloorId) => void;
  /** Fired when the camera settles on a storey the app is not showing yet. */
  onFocusFloor?: (f: FloorId) => void;
  onFatal?: (reason: string) => void;
  /** Fly-the-route state, for the bridge's Fly / Pause / Stop buttons. */
  onFlightChange?: (state: FlightState) => void;
}

export type FlightState = "idle" | "flying" | "paused";

/** A scripted camera move: the glide back from a flight to the route overview. */
interface CameraTween {
  from: FlightPose;
  to: FlightPose;
  t: number;
}

interface FloorParts {
  group: THREE.Group;
  walls: THREE.Mesh;
  edges: THREE.LineSegments;
  slab: THREE.Mesh;
  skirt: THREE.Mesh;
  ghostPlate: THREE.Mesh;
  ghostOutline: THREE.LineSegments;
  slabMaterial: THREE.MeshLambertMaterial;
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
  private controls: OrbitControls;
  private materials: Materials;
  private textures: TextureCache;
  private placements: PlacementSet;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTexture: THREE.Texture | null = null;

  private floorParts = new Map<FloorId, FloorParts>();
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
  private site: Site | null = null;
  private apron: { mesh: THREE.Mesh; dispose(): void } | null = null;
  private stairColumns: StairColumns | null = null;
  private builtColumnSpread = -1;
  private builtColumnKey = "";
  /** Suppresses auto-focus while the camera is being moved by the app itself. */
  private cameraDriven = false;

  private flight: RouteFlight | null = null;
  private flightState: FlightState = "idle";
  private tween: CameraTween | null = null;
  /** The storey last asked for while flying, so one change is asked for once
   *  rather than every frame until the app's answer comes back as a prop. */
  private flightFloorAsked: FloorId | null = null;

  private labels: LabelLayer;
  /** Canvas size in CSS px, cached: reading clientWidth every frame forces layout. */
  private viewW: number;
  private viewH: number;

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
  };
  /**
   * Any drag, pinch, pan or wheel on the map takes the camera back. A flight
   * that fights the user's hand is worse than no flight, and the gesture
   * itself says what they want to look at instead — so the camera stays
   * exactly where they grabbed it, with no reframe.
   */
  private onUserGesture = () => {
    this.tween = null;
    if (this.flight) this.endFlight(false);
  };

  constructor(host: HTMLElement, props: Viewer3DProps, cb: Viewer3DCallbacks) {
    this.host = host;
    this.props = props;
    this.cb = cb;
    this.placements = props.placements;

    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    this.viewW = w;
    this.viewH = h;

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
    this.renderer.shadowMap.enabled = !this.coarse;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is deprecated in r185
    host.appendChild(this.renderer.domElement);
    // After the canvas, so the labels sit over it in document order too.
    this.labels = new LabelLayer(host);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, w / h, CAMERA.near, CAMERA.far);
    this.materials = createMaterials();
    this.textures = new TextureCache(this.renderer);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.minPolarAngle = CAMERA.minPolarAngle;
    this.controls.maxPolarAngle = CAMERA.maxPolarAngle;
    this.controls.minDistance = CAMERA.minDistance;
    this.controls.maxDistance = CAMERA.maxDistance;
    this.controls.screenSpacePanning = false;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.8;
    this.controls.addEventListener("change", this.onOrbitChange);
    // Auto-focus: the storey the camera is aimed at becomes the active one.
    this.controls.addEventListener("end", this.pickFocusFromCamera);
    this.controls.addEventListener("start", this.onUserGesture);

    this.setupLights();
    this.setupGround();

    for (const f of FLOOR_ORDER) this.ensureFloor(f);
    this.setupApron();
    this.applyFloorStates();
    this.syncStairColumns();
    this.syncRoute();
    this.syncLabels();
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
    key.castShadow = !this.coarse;
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

  private setupGround(): void {
    // Sky, horizon and a ground that fades into it. See site.ts for why the
    // model needs a world around it rather than a flat void.
    this.site = buildSite({ shadows: !this.coarse });
    this.scene.background = this.site.background;
    for (const o of this.site.objects) this.scene.add(o);
  }

  /**
   * Lay the building's footprint on the ground under the stack.
   *
   * Built after the storeys, because it reuses the lowest one's slab outline —
   * the apron has to be the building's real shape or it reads as a rug rather
   * than as the site the building stands on.
   */
  private setupApron(): void {
    if (this.apron) {
      this.scene.remove(this.apron.mesh);
      this.apron.dispose();
      this.apron = null;
    }
    const lower = this.floorParts.get("lower");
    const slab = lower?.slab.geometry;
    if (!slab) return;
    this.apron = buildApron(slab);
    this.scene.add(this.apron.mesh);
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
    walls.castShadow = !this.coarse;
    walls.receiveShadow = !this.coarse;
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
    slab.receiveShadow = !this.coarse;
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

  /** How visible the unfocused storeys are at the current tilt. Shared with
   *  the labels, so a storey's names fade exactly as its walls do. */
  private ghostOpacity(): number {
    return ghostOpacityForDimension(dimensionForElevation(this.currentElevationDeg()));
  }

  private applyFloorStates(): void {
    const activeIdx = FLOOR_INDEX[this.props.activeFloor];
    // Looking straight down, the storeys are all at the same height, so the
    // unfocused ones would sit exactly on top of the one being read and turn
    // it to mush. They fade out as the camera flattens toward plan, which is
    // also what makes "flat" read as a plan of ONE floor rather than a bad 3D
    // view — and back in the moment the drag tilts away from it, since this
    // is read straight off the camera's own elevation now.
    const ghost = this.ghostOpacity();

    // Every storey is always on screen. Picking a floor changes *emphasis*, not
    // visibility: this is a map of a three-storey building, and hiding two of
    // them to look at one throws away the thing 3D was for. The unfocused
    // storeys stay legible but recede, and go translucent so the focused floor
    // is never hidden underneath one of them.
    for (const floor of FLOOR_ORDER) {
      const parts = this.floorParts.get(floor);
      if (!parts) continue;
      const focus = FLOOR_INDEX[floor] === activeIdx;
      parts.group.position.y = storeyY(floor, this.spread);

      parts.edges.visible = focus;
      parts.ghostPlate.visible = false;
      parts.ghostOutline.visible = false;

      const hidden = !focus && ghost < 0.02;
      parts.walls.visible = !hidden;
      parts.slab.visible = !hidden;
      parts.skirt.visible = !hidden;

      parts.slabMaterial.color.setHex(focus ? 0xffffff : 0xcfc9c0);
      parts.slabMaterial.opacity = focus ? 1 : ghost;
      parts.slabMaterial.transparent = !focus;
      parts.slabMaterial.depthWrite = focus;
      parts.slabMaterial.needsUpdate = true;

      for (const m of parts.wallMaterials) {
        m.opacity = focus ? 1 : ghost * GHOST_WALL_FACTOR;
        m.transparent = !focus;
        m.depthWrite = focus;
        m.needsUpdate = true;
      }

      parts.walls.castShadow = !this.coarse && focus;
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
    this.setupApron();
    this.applyFloorStates();
    for (const f of FLOOR_ORDER) void this.loadFloorTexture(f);
    this.builtColumnSpread = -1;
    this.syncStairColumns();
    this.builtRouteKey = "";
    this.syncRoute();
    this.syncLabels();
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
    if (horiz < 1e-6 && Math.abs(offset.y) < 1e-6) return DEFAULT_ELEVATION_DEG; // not placed yet
    return (Math.atan2(offset.y, horiz) * 180) / Math.PI;
  }

  /**
   * Decide which storey the camera is looking at, and tell the app.
   *
   * "Looking at" is the orbit target's height, not the camera's: you can be
   * above the roof and still be studying the lower level. Nearest storey by Y
   * wins, with a dead zone so a target sitting almost exactly between two
   * floors does not flip back and forth as the user nudges the view.
   *
   * Skipped entirely when the stack is collapsed — with the camera flattened
   * to plan every storey is at the same height, so there is nothing to infer
   * and the answer would be noise.
   */
  private pickFocusFromCamera = () => {
    if (this.disposed || this.cameraDriven) return;
    if (this.spread < 6) return;
    const y = this.controls.target.y;
    let best: FloorId | null = null;
    let bestD = Infinity;
    let secondD = Infinity;
    for (const floor of FLOOR_ORDER) {
      const d = Math.abs(storeyY(floor, this.spread) - y);
      if (d < bestD) {
        secondD = bestD;
        bestD = d;
        best = floor;
      } else if (d < secondD) {
        secondD = d;
      }
    }
    // Ambiguous: the two nearest storeys are within 15% of each other. Leave
    // the choice alone rather than thrashing it.
    if (!best || best === this.props.activeFloor) return;
    if (secondD - bestD < this.spread * 0.15) return;
    this.cb.onFocusFloor?.(best);
  };

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
    this.tween = null;
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
  frameRoute(): void {
    const pose = this.routeFramePose();
    if (pose) this.placeCameraPose(pose);
    else this.resetView();
  }

  /** Where `frameRoute` puts the camera, without putting it there — so the end
   *  of a flight can glide to it instead of cutting. */
  private routeFramePose(): FlightPose | null {
    if (!this.route3d) return null;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const pts = this.route3d.points;
    for (let i = 0; i < pts.length; i += 3) box.expandByPoint(v.set(pts[i], pts[i + 1], pts[i + 2]));
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, size.y * 2) * 0.5 + 90;
    const dist = clamp(
      radius / Math.tan((CAMERA.fov * Math.PI) / 360) / this.visibleFraction(),
      CAMERA.minDistance,
      CAMERA.maxDistance
    );
    return {
      target: centre,
      position: this.orbitPosition(centre, dist, DEFAULT_ELEVATION_DEG, CAMERA.overviewAzimuthDeg),
    };
  }

  /** The centre of the built model, not the page origin — the building only
   *  occupies part of its sheet, so those are tens of feet apart. */
  private modelCentre(): THREE.Vector3 {
    const parts = this.floorParts.get("main") ?? this.floorParts.values().next().value;
    const sphere = parts?.walls.geometry.boundingSphere;
    const c = sphere ? sphere.center.clone() : new THREE.Vector3();
    c.y = storeyY("main", this.spread);
    return c;
  }

  resetView(): void {
    const c = this.modelCentre();
    const parts = this.floorParts.get("main");
    const r = parts?.walls.geometry.boundingSphere?.radius ?? 600;
    // 1.5 left the building as a small island in a lot of ground. The stack is
    // always open at its full spread, so allow for that as well as the plan
    // extent rather than padding blindly.
    const reach = Math.max(r, r * 0.85 + this.spread * 0.9);
    const dist = clamp(
      (reach * 1.12) / Math.tan((CAMERA.fov * Math.PI) / 360) / this.visibleFraction(),
      CAMERA.minDistance,
      CAMERA.maxDistance
    );
    this.placeCamera(c, dist, DEFAULT_ELEVATION_DEG, CAMERA.overviewAzimuthDeg);
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
    if (obscured < 1) {
      // clearViewOffset() leaves `aspect` as the last offset set it; restore it
      // first so its own updateProjectionMatrix() uses the real one.
      this.camera.aspect = w / h;
      this.camera.clearViewOffset();
    } else {
      // setViewOffset sets aspect = w / h and updates the projection itself.
      this.camera.setViewOffset(w, h, 0, obscured / 2, w, h);
    }
  }

  private orbitPosition(
    target: THREE.Vector3,
    dist: number,
    elevDeg: number,
    azDeg: number
  ): THREE.Vector3 {
    const el = (elevDeg * Math.PI) / 180;
    const az = (azDeg * Math.PI) / 180;
    return new THREE.Vector3(
      target.x + dist * Math.cos(el) * Math.sin(az),
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.cos(az)
    );
  }

  private placeCamera(target: THREE.Vector3, dist: number, elevDeg: number, azDeg: number): void {
    this.placeCameraPose({ target, position: this.orbitPosition(target, dist, elevDeg, azDeg) });
  }

  private placeCameraPose(pose: FlightPose): void {
    this.controls.target.copy(pose.target);
    this.camera.position.copy(pose.position);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.applyFloorStates();
    this.invalidate();
  }

  // ---------------------------------------------------------------- flight

  /**
   * Fly the current route as a low drone (see `FLY` in theme.ts and
   * flight.ts). The camera is driven directly while it runs: OrbitControls'
   * own update() is skipped, because its distance and polar clamps would
   * fight a scripted pose, and it takes over again the moment anyone touches
   * the map.
   *
   * With reduced motion it does not glide: it cuts from one direction step to
   * the next, holding each, and cuts back to the overview at the end.
   */
  startFlight(): void {
    if (this.disposed || !this.route3d || this.route3d.totalFt <= 0) return;
    this.tween = null;
    this.flight = new RouteFlight(
      this.route3d,
      { position: this.camera.position.clone(), target: this.controls.target.clone() },
      this.reducedMotion
    );
    this.flightFloorAsked = null;
    this.setFlightState("flying");
    // Start on the storey the route starts on, whatever the user was reading.
    this.askFloor(this.route3d.legs[0].floor);
    this.invalidate();
  }

  pauseFlight(): void {
    if (this.flight && this.flightState === "flying") this.setFlightState("paused");
  }

  resumeFlight(): void {
    if (this.flight && this.flightState === "paused") this.setFlightState("flying");
  }

  /** Stop and show the whole route again — the Stop button, as opposed to a
   *  drag, which hands the camera back where it is. */
  stopFlight(): void {
    if (this.flight) this.endFlight(true);
  }

  private endFlight(reframe: boolean): void {
    this.flight = null;
    this.flightFloorAsked = null;
    this.setFlightState("idle");
    if (!reframe) return;
    const to = this.routeFramePose();
    if (!to) return;
    if (this.reducedMotion) {
      this.placeCameraPose(to);
    } else {
      this.tween = {
        from: { position: this.camera.position.clone(), target: this.controls.target.clone() },
        to,
        t: 0,
      };
    }
  }

  private setFlightState(state: FlightState): void {
    if (state === this.flightState) return;
    this.flightState = state;
    this.cb.onFlightChange?.(state);
  }

  private askFloor(floor: FloorId): void {
    if (floor === this.props.activeFloor || floor === this.flightFloorAsked) return;
    this.flightFloorAsked = floor;
    this.cb.onFocusFloor?.(floor);
  }

  /** Point the camera at a pose without going through OrbitControls. */
  private applyPose(pose: FlightPose): void {
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    this.camera.lookAt(pose.target);
    // The ghost fade reads the camera's elevation, and nothing fires the
    // controls' "change" event while the camera is scripted.
    this.applyFloorStates();
    this.invalidate();
  }

  /**
   * The active storey follows the drone: it is the highest one the camera is
   * above. Keyed to the camera rather than to the route point it follows,
   * because on a riser the camera passes a slab after the route does — going
   * up, the storey above stays a ghost until the camera is through it, so the
   * picture is never the underside of an opaque floor.
   */
  private followFloorInFlight(): void {
    const y = this.camera.position.y;
    let floor: FloorId = FLOOR_ORDER[0];
    for (const f of FLOOR_ORDER) if (storeyY(f, this.spread) <= y - 1) floor = f;
    this.askFloor(floor);
  }

  private stepFlight(dt: number): void {
    const flight = this.flight;
    if (!flight || this.flightState !== "flying") return;
    this.applyPose(flight.step(dt));
    if (!flight.descending) this.followFloorInFlight();
    if (flight.done) this.endFlight(true);
  }

  private stepTween(dt: number): void {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + dt / FLY.outroS);
    const e = easeInOutCubic(tw.t);
    this.applyPose({
      position: tw.from.position.clone().lerp(tw.to.position, e),
      target: tw.from.target.clone().lerp(tw.to.target, e),
    });
    if (tw.t >= 1) {
      this.tween = null;
      this.controls.update(); // hand back with OrbitControls' state in sync
    }
  }

  // ---------------------------------------------------------------- labels

  private syncLabels(): void {
    const d = this.props.directions;
    this.labels.setLabels(
      labelSpecs(
        this.props.floors,
        this.placements,
        this.spread,
        this.route3d,
        d ? { start: d.startLabel, end: d.endLabel } : null
      )
    );
    this.invalidate();
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

    const floorChanged = prev.activeFloor !== next.activeFloor;
    if (floorChanged) {
      this.applyFloorStates();
      // In flight the camera is on the route, and the floor is following it
      // rather than the other way round.
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
    if (
      prev.routeKey !== next.routeKey ||
      prev.floors !== next.floors ||
      prev.directions !== next.directions
    ) {
      this.syncLabels();
    }

    if (prev.obscuredBottom !== next.obscuredBottom) {
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
      this.viewW = w;
      this.viewH = h;
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

    // A flight, or the glide back from one, drives the camera itself and marks
    // the frame dirty, so it costs frames only while one is running.
    // OrbitControls stays out of it until then — see startFlight().
    const scripted = this.flight !== null || this.tween !== null;
    this.stepFlight(dt);
    this.stepTween(dt);

    // controls.update() returns true while damping is still settling. The
    // previous guard tested `enableDamping`, which is a constant true, so the
    // early-out could never fire and a still scene redrew every frame — the
    // whole point of rendering on demand.
    const settling = scripted ? false : this.controls.update();
    if (!this.dirty && !animating && !settling) return;

    this.renderer.render(this.scene, this.camera);
    // Labels are projected only on frames that are actually drawn, so a still
    // map moves no DOM either.
    this.labels.update(
      this.camera,
      this.viewW,
      this.viewH,
      this.props.activeFloor,
      this.ghostOpacity()
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
    this.controls.removeEventListener("change", this.onOrbitChange);
    this.controls.removeEventListener("end", this.pickFocusFromCamera);
    this.controls.removeEventListener("start", this.onUserGesture);
    this.controls.dispose();
    this.flight = null;
    this.tween = null;
    this.labels.dispose();

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
    if (this.apron) {
      this.scene.remove(this.apron.mesh);
      this.apron.dispose();
      this.apron = null;
    }
    if (this.site) {
      for (const o of this.site.objects) this.scene.remove(o);
      this.site.dispose();
      this.site = null;
    }
    this.scene.background = null;
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
