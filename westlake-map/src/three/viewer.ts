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

import { FLOOR_INDEX, GROUND_Y, SPREAD_EXPLODED, spreadForElevation, storeyY } from "./units";
import { loadPlacements, type PlacementSet } from "./placement";
import { buildWallGeometry, buildWallTopEdges } from "./walls";
import { buildSlabGeometry } from "./slab";
import { TextureCache } from "./textures";
import { liftRoute, type Route3D } from "./routeLift";
import { buildRouteObject, type RouteObject } from "./routeObject";
import {
  CAMERA,
  clamp,
  createMaterials,
  disposeMaterials,
  isCoarsePointer,
  prefersReducedMotion,
  type Materials,
} from "./theme";

export interface Viewer3DProps {
  floors: Record<FloorId, FloorData>;
  stairs: StairLink[];
  activeFloor: FloorId;
  route: GridRoute | null;
  /** Cheap identity for the route — rebuilding its geometry is the costly bit. */
  routeKey: string;
  directions: Directions | null;
  activeStep: number | null;
}

export interface Viewer3DCallbacks {
  onPickFloor?: (f: FloorId) => void;
  onFatal?: (reason: string) => void;
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

  private spread = SPREAD_EXPLODED;
  private targetSpread = SPREAD_EXPLODED;

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

  constructor(host: HTMLElement, props: Viewer3DProps, cb: Viewer3DCallbacks) {
    this.host = host;
    this.props = props;
    this.cb = cb;
    this.placements = loadPlacements();

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
    this.renderer.shadowMap.enabled = !this.coarse;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is deprecated in r185
    host.appendChild(this.renderer.domElement);

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
    this.controls.addEventListener("change", this.invalidate);

    this.setupLights();
    this.setupGround();

    for (const f of FLOOR_ORDER) this.ensureFloor(f);
    this.applyFloorStates();
    this.syncRoute();
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
    // No grid helper — a grid is the tell of a default demo, and the building's
    // own cast shadow is a better ground cue.
    const g = new THREE.PlaneGeometry(4000, 4000);
    const ground = new THREE.Mesh(g, this.materials.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.receiveShadow = !this.coarse;
    ground.name = "ground";
    this.scene.add(ground);
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

  private applyFloorStates(): void {
    const activeIdx = FLOOR_INDEX[this.props.activeFloor];

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

      parts.walls.visible = true;
      parts.slab.visible = true;
      parts.skirt.visible = true;
      parts.edges.visible = focus;
      parts.ghostPlate.visible = false;
      parts.ghostOutline.visible = false;

      parts.slabMaterial.color.setHex(focus ? 0xffffff : 0xcfc9c0);
      parts.slabMaterial.opacity = focus ? 1 : 0.42;
      parts.slabMaterial.transparent = !focus;
      parts.slabMaterial.depthWrite = focus;
      parts.slabMaterial.needsUpdate = true;

      for (const m of parts.wallMaterials) {
        m.opacity = focus ? 1 : 0.3;
        m.transparent = !focus;
        m.depthWrite = focus;
        m.needsUpdate = true;
      }

      parts.walls.castShadow = !this.coarse && focus;
      parts.walls.renderOrder = focus ? 0 : -1;
      parts.slab.renderOrder = focus ? 0 : -1;
    }
  }

  // ----------------------------------------------------------------- route

  private syncRoute(): void {
    const { route, routeKey, directions } = this.props;
    const spreadChanged = Math.abs(this.builtRouteSpread - this.spread) > 0.5;
    if (route && routeKey === this.builtRouteKey && !spreadChanged) return;

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
    if (!this.route3d) {
      this.resetView();
      return;
    }
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const pts = this.route3d.points;
    for (let i = 0; i < pts.length; i += 3) box.expandByPoint(v.set(pts[i], pts[i + 1], pts[i + 2]));
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, size.y * 2) * 0.5 + 90;
    const dist = clamp(
      radius / Math.tan((CAMERA.fov * Math.PI) / 360),
      CAMERA.minDistance,
      CAMERA.maxDistance
    );
    this.placeCamera(centre, dist, CAMERA.overviewElevationDeg, CAMERA.overviewAzimuthDeg);
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
    const dist = clamp(
      (r * 1.5) / Math.tan((CAMERA.fov * Math.PI) / 360),
      CAMERA.minDistance,
      CAMERA.maxDistance
    );
    this.placeCamera(c, dist, CAMERA.overviewElevationDeg, CAMERA.overviewAzimuthDeg);
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

  // ------------------------------------------------------------- lifecycle

  update(next: Viewer3DProps): void {
    if (this.disposed) return;
    const prev = this.props;
    this.props = next;

    const floorChanged = prev.activeFloor !== next.activeFloor;
    if (floorChanged) {
      this.applyFloorStates();
      for (const f of FLOOR_ORDER) void this.loadFloorTexture(f);
      this.invalidate();
    }
    if (prev.routeKey !== next.routeKey) {
      this.syncRoute();
      this.applyFloorStates();
      this.frameRoute();
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
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.invalidate();
    });
  }

  private tick = (time: number) => {
    if (this.disposed || this.hidden) return;
    const dt = this.lastTime ? Math.min(0.05, (time - this.lastTime) / 1000) : 0;
    this.lastTime = time;

    // Orbiting down toward the horizon collapses the stack into something that
    // looks like an actual building; orbiting up opens it into a diagram.
    const elev = Math.PI / 2 - this.controls.getPolarAngle();
    this.targetSpread = spreadForElevation(elev);
    if (Math.abs(this.targetSpread - this.spread) > 0.01) {
      // ~0.25s time constant, so it never jitters while orbiting.
      this.spread += (this.targetSpread - this.spread) * Math.min(1, dt / 0.25);
      this.applyFloorStates();
      if (Math.abs(this.builtRouteSpread - this.spread) > 0.5) this.syncRoute();
      this.dirty = true;
    }

    const animating = this.routeObject !== null && !this.reducedMotion;
    if (animating) this.routeObject?.update(dt);

    // controls.update() returns true while damping is still settling. The
    // previous guard tested `enableDamping`, which is a constant true, so the
    // early-out could never fire and a still scene redrew every frame — the
    // whole point of rendering on demand.
    const settling = this.controls.update();
    if (!this.dirty && !animating && !settling) return;

    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost);
    this.controls.removeEventListener("change", this.invalidate);
    this.controls.dispose();

    if (this.routeObject) {
      this.scene.remove(this.routeObject.group);
      this.routeObject.dispose();
      this.routeObject = null;
    }
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
