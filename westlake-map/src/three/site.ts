// The world the building sits in: sky, ground, and the apron under the stack.
//
// Before this, the model floated in a flat beige void. That reads as unsettling
// rather than as neutral, and the reason is specific: with no horizon and no
// ground texture there is nothing in the picture that has a *size*, so the eye
// cannot place the building in a world — it reads as an object suspended in
// nothing. The exploded stack makes it worse, because the upper storeys are 220
// ft up with visibly nothing holding them there.
//
// Three cheap pieces fix it, and none of them is scenery for its own sake:
//
//   sky      a real horizon. It appears as you tilt down and vanishes as you
//            tilt to plan, which is what tells you the dial is a camera and not
//            a change to the model.
//   ground   a disc that fades into the horizon haze instead of an infinite
//            plane with a hard edge somewhere out in the distance.
//   apron    the building's own footprint laid on the ground under the stack.
//            This is the piece that stops the floating: the lowest storey has
//            something directly beneath it in its own shape, so the stack reads
//            as standing on a site rather than hanging in the air.

import * as THREE from "three";

import { GROUND_Y } from "./units";

export interface Site {
  objects: THREE.Object3D[];
  background: THREE.Texture;
  dispose(): void;
}

// Tuned against the paper palette: the scene is near-white ink on off-white, so
// the sky has to stay pale or the building stops being the brightest thing.
const SKY_TOP = "#cfdbe6";
const SKY_HORIZON = "#e9e4db";
const HAZE = "#ded7cc";
const GROUND_NEAR = "#cfc7ba";

const GROUND_RADIUS = 2600;

/**
 * An equirectangular sky. Assigned to `scene.background`, so it behaves as a
 * real environment: the horizon sits where the horizon should be and moves
 * correctly as the camera orbits, which a CSS backdrop cannot do.
 */
function skyTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, SKY_TOP);
  // The equator of an equirectangular map is the horizon, so the sky's own
  // gradient has to land its bright band at exactly half height.
  grad.addColorStop(0.46, SKY_HORIZON);
  grad.addColorStop(0.5, HAZE);
  grad.addColorStop(1, GROUND_NEAR);
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Radial falloff so the ground dissolves into the haze instead of ending. */
function groundAlpha(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const r = c.width / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.55, "#ffffff");
  grad.addColorStop(1, "#000000");
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

export function buildSite(opts: { shadows: boolean }): Site {
  const owned: Array<{ dispose(): void }> = [];
  const objects: THREE.Object3D[] = [];

  const background = skyTexture();
  owned.push(background);

  const alpha = groundAlpha();
  owned.push(alpha);

  const groundGeo = new THREE.CircleGeometry(GROUND_RADIUS, 96);
  owned.push(groundGeo);
  const groundMat = new THREE.MeshLambertMaterial({
    color: GROUND_NEAR,
    alphaMap: alpha,
    transparent: true,
    depthWrite: true,
  });
  owned.push(groundMat);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  ground.receiveShadow = opts.shadows;
  ground.name = "ground";
  objects.push(ground);

  return {
    objects,
    background,
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}

/**
 * The apron: the building's own footprint, laid flat on the ground beneath the
 * stack. Built from the lowest storey's slab geometry so its outline is the
 * real one, not a rectangle.
 */
export function buildApron(slabTop: THREE.BufferGeometry): {
  mesh: THREE.Mesh;
  dispose(): void;
} {
  const geo = slabTop.clone();
  // Flatten to a single plane at ground level. The slab's own Y varies with
  // storey placement; the apron is a shadow of the plan, not a copy of a floor.
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, GROUND_Y + 0.4);
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.deleteAttribute("uv"); // untextured: this is site, not map

  const mat = new THREE.MeshLambertMaterial({
    color: 0xb9b0a3,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "apron";
  mesh.renderOrder = -2;
  return {
    mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
