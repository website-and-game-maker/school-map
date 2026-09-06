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
import { FLOOR_IMAGES } from "../data/floors";

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
      const src = FLOOR_IMAGES[floor];
      const bitmap = tone(await decode(src, maxEdge));
      const tex = new THREE.Texture(bitmap as unknown as HTMLImageElement);
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

/**
 * Lift the scan's blacks and pull its contrast back.
 *
 * The plans use dense hatching for double-height spaces and site features. At
 * full contrast those areas render as black holes punched through the model,
 * which reads as dirt rather than as drawing. Lifting the blacks to a warm dark
 * grey keeps every room number legible while letting the hatching sit back as
 * texture. design.md's calibration target is unshadowed paper landing near
 * #f6f3ef, which this holds.
 */
function tone(src: ImageBitmap | HTMLCanvasElement): HTMLCanvasElement | ImageBitmap {
  const w = src.width;
  const h = src.height;
  if (!w || !h) return src;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  ctx.filter = "brightness(1.06) contrast(0.78)";
  ctx.drawImage(src as CanvasImageSource, 0, 0);
  if ("close" in src && typeof src.close === "function") src.close();
  return canvas;
}

/**
 * Decode and downscale. createImageBitmap does both off the main thread, which
 * matters because decoding a 7.7 Mpx JPEG on the main thread is a visible stall
 * on the frame the user switches into 3D.
 */
async function decode(src: string, maxEdge: number): Promise<ImageBitmap | HTMLCanvasElement> {
  const res = await fetch(src);
  const blob = await res.blob();
  if (typeof createImageBitmap === "function") {
    try {
      const probe = await createImageBitmap(blob);
      const scale = Math.min(1, maxEdge / Math.max(probe.width, probe.height));
      if (scale >= 1) return probe;
      const w = Math.round(probe.width * scale);
      const h = Math.round(probe.height * scale);
      const out = await createImageBitmap(probe, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: "high",
      });
      probe.close();
      return out;
    } catch {
      // fall through to the canvas path
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no 2d context"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}
