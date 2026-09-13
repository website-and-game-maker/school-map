// The plan scans, as floor textures.
//
// The pages are 3167x2448. Uploaded at full resolution with mipmaps that is
// ~41 MB of VRAM each, and three of them will lose the context on a mid-range
// phone. So each is decoded and downscaled off the main thread, and only the
// focused storey is allowed the high-resolution copy.
//
// Anisotropy is the setting that matters most here and is easy to miss: at a
// 40-degree camera the far half of every plate is at a grazing angle, and
// without it the ink turns to grey soup. It buys far more legibility per byte
// than extra resolution does.

import * as THREE from "three";
import type { FloorId } from "../types";
import { renderFloorPlan, roomsOf } from "../lib/floorPlan";

interface Entry {
  texture: THREE.Texture;
  refs: number;
}

export class TextureCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<THREE.Texture>>();
  private maxAnisotropy: number;

  constructor(renderer: THREE.WebGLRenderer) {
    this.maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  private key(floor: FloorId, maxEdge: number): string {
    return `${floor}@${maxEdge}`;
  }

  async load(floor: FloorId, maxEdge: number): Promise<THREE.Texture> {
    const key = this.key(floor, maxEdge);
    const hit = this.entries.get(key);
    if (hit) {
      hit.refs++;
      return hit.texture;
    }
    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const job = (async () => {
      // Drawn, not decoded. The plate is the school rendered from its own
      // geometry, so the scan never reaches the browser.
      const { w, h } = roomsOf(floor);
      const scale = maxEdge / Math.max(w, h);
      const canvas = renderFloorPlan(floor, { scale, labels: scale > 0.35 });
      const tex = new THREE.Texture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = this.maxAnisotropy;
      tex.needsUpdate = true;
      this.entries.set(key, { texture: tex, refs: 1 });
      this.pending.delete(key);
      return tex;
    })();
    this.pending.set(key, job);
    return job;
  }

  release(floor: FloorId, maxEdge: number): void {
    const key = this.key(floor, maxEdge);
    const e = this.entries.get(key);
    if (!e) return;
    e.refs--;
    if (e.refs <= 0) {
      e.texture.dispose();
      this.entries.delete(key);
    }
  }

  disposeAll(): void {
    for (const e of this.entries.values()) e.texture.dispose();
    this.entries.clear();
    this.pending.clear();
  }
}
