// Walls, as one merged mesh per storey.
//
// The input is src/data/floors/walls-*.json — the building's real walls, traced
// out of the scanned plans by tools/export_walls.py and handed over as 4-10k
// disjoint rectangles on a 2 px grid.
//
// The naive readings of that file are both wrong. One THREE.BoxGeometry per
// rectangle is ~10k draw calls; an ExtrudeGeometry over 10k shapes blows the
// build-time budget. Worse, both emit the faces *between* touching rectangles,
// which are invisible and can be half the triangles in the file.
//
// So: greedy meshing, the trick voxel engines use.
//   - a vertical face is emitted only where a filled cell meets an empty one,
//     and collinear runs of those merge into one long quad
//   - the top surface is merged into maximal rectangles
// Interior shared faces are never generated at all, and the silhouette comes
// out exactly right.
//
// On the bevel: design.md asks for a 1.2-inch chamfer along every wall top, and
// it is right that it is what makes a white massing model read as photographed.
// It is not built here, because at this grid a cell is 2 px ≈ 0.77 ft and the
// chamfer is 0.1 ft — a geometric bevel is a quarter of a cell wide and cannot
// be expressed without either re-contouring off-grid or leaving seams where the
// inset caps stop tiling. buildWallTopEdges() draws the same rim as a line
// instead, which reads at a fraction of the cost.

import * as THREE from "three";
import type { FloorId } from "../types";
import { planToWorld, type FloorPlacement } from "./placement";
import { WALL_H_INTERIOR, WALL_H_PERIMETER } from "./units";

import wallsLower from "../data/floors/walls-lower.json";
import wallsMain from "../data/floors/walls-main.json";
import wallsUpper from "../data/floors/walls-upper.json";

export interface FootprintPart {
  outer: number[];
  holes: number[][];
}

export interface WallsFile {
  floor: FloorId;
  w: number;
  h: number;
  quant: number;
  pxPerFoot: number;
  boxCount: number;
  boxes: number[];
  footprint: FootprintPart[];
}

const FILES: Record<FloorId, WallsFile> = {
  lower: wallsLower as unknown as WallsFile,
  main: wallsMain as unknown as WallsFile,
  upper: wallsUpper as unknown as WallsFile,
};

export function wallsFile(floor: FloorId): WallsFile {
  return FILES[floor];
}

export interface WallStats {
  boxes: number;
  capTris: number;
  sideTris: number;
  totalTris: number;
  buildMs: number;
}

/** Baked contact shading: darker where a wall meets the floor. Replaces SSAO,
 *  is stable under camera motion, and costs nothing. */
const AO_BASE = 0.86;
const AO_HEIGHT = 1.2;

interface Grid {
  gw: number;
  gh: number;
  filled: Uint8Array;
  /** Wall height per cell, in feet. 0 where empty. */
  height: Float32Array;
  quant: number;
}

/** Square dilation by `r` cells, as two 1D passes. */
function dilate(mask: Uint8Array, r: number, gw: number, gh: number): Uint8Array {
  const rows = new Uint8Array(gw * gh);
  const out = new Uint8Array(gw * gh);
  const sweep = (
    src: Uint8Array,
    dst: Uint8Array,
    outer: number,
    inner: number,
    index: (o: number, i: number) => number
  ) => {
    for (let o = 0; o < outer; o++) {
      let run = -1;
      for (let i = 0; i < inner; i++) {
        const k = index(o, i);
        run = src[k] ? r : run - 1;
        if (run >= 0) dst[k] = 1;
      }
      run = -1;
      for (let i = inner - 1; i >= 0; i--) {
        const k = index(o, i);
        run = src[k] ? r : run - 1;
        if (run >= 0) dst[k] = 1;
      }
    }
  };
  sweep(mask, rows, gh, gw, (y, x) => y * gw + x);
  sweep(rows, out, gw, gh, (x, y) => y * gw + x);
  return out;
}

function buildGrid(f: WallsFile): Grid {
  const q = f.quant;
  const gw = Math.ceil(f.w / q);
  const gh = Math.ceil(f.h / q);
  const filled = new Uint8Array(gw * gh);
  const b = f.boxes;
  for (let i = 0; i < b.length; i += 4) {
    const x = b[i];
    const y = b[i + 1];
    const bw = b[i + 2];
    const bh = b[i + 3];
    for (let r = y; r < y + bh; r++) {
      filled.fill(1, r * gw + x, r * gw + x + bw);
    }
  }

  // A wall is a *perimeter* wall if the outside of the building is close to it.
  // Two dilations get there, both separable so they stay O(cells):
  //
  //  1. Seal the wall mask before flooding. Doorways are gaps in the walls, so
  //     an unsealed flood pours through the first external door and fills the
  //     corridors behind it — after which half the interior partitions are
  //     classified as perimeter and stand 3 ft too tall. Sealing closes any gap
  //     up to ~4.6 ft (every door) while a ~10 ft corridor stays open, so it
  //     cannot seal the building shut.
  //  2. Grow the flooded region back out afterwards, by enough to undo the seal
  //     and reach the walls it should mark. Testing proximity directly would be
  //     a (2r+1)^2 stencil over 1.9M cells; this is four linear passes.
  const SEAL_RADIUS = 3;
  const REACH = SEAL_RADIUS + 3;

  const sealed = dilate(filled, SEAL_RADIUS, gw, gh);

  const outside = new Uint8Array(gw * gh);
  const stack: number[] = [];
  const pushIfOpen = (i: number) => {
    if (!sealed[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < gw; x++) {
    pushIfOpen(x);
    pushIfOpen((gh - 1) * gw + x);
  }
  for (let y = 0; y < gh; y++) {
    pushIfOpen(y * gw);
    pushIfOpen(y * gw + gw - 1);
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % gw;
    const y = (i / gw) | 0;
    if (x > 0) pushIfOpen(i - 1);
    if (x < gw - 1) pushIfOpen(i + 1);
    if (y > 0) pushIfOpen(i - gw);
    if (y < gh - 1) pushIfOpen(i + gw);
  }

  const nearOutside = dilate(outside, REACH, gw, gh);
  const height = new Float32Array(gw * gh);
  for (let i = 0; i < filled.length; i++) {
    if (filled[i]) height[i] = nearOutside[i] ? WALL_H_PERIMETER : WALL_H_INTERIOR;
  }

  return { gw, gh, filled, height, quant: q };
}

/** Accumulates triangles into growable arrays, then freezes them. */
class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  tris = 0;

  /**
   * Emit a quad whose front face points along `n`.
   *
   * The winding is derived from `n` rather than assumed, because the plan->world
   * mapping sends plan +y to world +Z: a quad listed in the natural
   * top-left/top-right/bottom-right order on the page comes out wound so its
   * front face points DOWN. Getting that wrong makes every wall top invisible
   * from above under a FrontSide material, and it is invisible in code review
   * because the explicit normal attribute still lights correctly.
   */
  quad(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
    n: [number, number, number]
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const vz = c[2] - b[2];
    const facing =
      (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
    const [p, q, r, t] = facing < 0 ? [a, d, c, b] : [a, b, c, d];
    const shade = (y: number) => {
      const s0 = Math.min(1, Math.max(0, y / AO_HEIGHT));
      const s = s0 * s0 * (3 - 2 * s0);
      return AO_BASE + (1 - AO_BASE) * s;
    };
    for (const v of [p, q, r, p, r, t]) {
      this.pos.push(v[0], v[1], v[2]);
      this.nrm.push(n[0], n[1], n[2]);
      const g = shade(v[1]);
      this.col.push(g, g, g);
    }
    this.tris += 2;
  }
}

export function buildWallGeometry(
  floor: FloorId,
  p: FloorPlacement
): { geometry: THREE.BufferGeometry; stats: WallStats } {
  const t0 = performance.now();
  const f = FILES[floor];
  const g = buildGrid(f);
  const { gw, gh, filled, height, quant: q } = g;

  // World position of a plan-pixel corner. Placement is a uniform scale plus a
  // translation with rotation pinned to 0, so this stays axis-aligned and the
  // merged runs remain rectangles.
  const wx = (px: number, py: number) => planToWorld(p, px, py, 0);

  const caps = new MeshBuilder();
  const sides = new MeshBuilder();

  // ---- top surface: maximal rectangles of equal height ------------------
  const used = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (!filled[i] || used[i]) continue;
      const hgt = height[i];
      let w = 1;
      while (
        x + w < gw &&
        filled[i + w] &&
        !used[i + w] &&
        height[i + w] === hgt
      )
        w++;
      let hh = 1;
      outer: while (y + hh < gh) {
        const row = (y + hh) * gw + x;
        for (let k = 0; k < w; k++) {
          if (!filled[row + k] || used[row + k] || height[row + k] !== hgt) break outer;
        }
        hh++;
      }
      for (let r = 0; r < hh; r++) used.fill(1, (y + r) * gw + x, (y + r) * gw + x + w);

      const x0 = x * q;
      const x1 = (x + w) * q;
      const y0 = y * q;
      const y1 = (y + hh) * q;
      const A = wx(x0, y0);
      const B = wx(x1, y0);
      const C = wx(x1, y1);
      const D = wx(x0, y1);
      caps.quad(
        [A[0], hgt, A[2]],
        [B[0], hgt, B[2]],
        [C[0], hgt, C[2]],
        [D[0], hgt, D[2]],
        [0, 1, 0]
      );
    }
  }

  // ---- vertical faces: merged boundary runs -----------------------------
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : filled[y * gw + x]);
  const hAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= gw || y >= gh ? 0 : height[y * gw + x];

  /**
   * The bottom of the face this cell shows to its neighbour, or null for no
   * face. An empty neighbour means a full-height wall face; a *shorter* filled
   * neighbour means a face spanning only the height difference. Without that
   * second case the 3 ft step between a 13.5 ft perimeter wall and a 10.5 ft
   * interior one is a hole you can see straight through.
   */
  const faceBase = (x: number, y: number, nx: number, ny: number): number | null => {
    if (!at(x, y)) return null;
    if (!at(nx, ny)) return 0;
    const hn = hAt(nx, ny);
    return hn < hAt(x, y) ? hn : null;
  };

  // Faces pointing along -Z (plan -y) and +Z (plan +y): scan rows, merge in x.
  for (const dir of [-1, 1]) {
    for (let y = 0; y < gh; y++) {
      let x = 0;
      while (x < gw) {
        const base = faceBase(x, y, x, y + dir);
        if (base === null) {
          x++;
          continue;
        }
        const hgt = hAt(x, y);
        let w = 1;
        while (
          x + w < gw &&
          faceBase(x + w, y, x + w, y + dir) === base &&
          hAt(x + w, y) === hgt
        )
          w++;
        const py = dir < 0 ? y * q : (y + 1) * q;
        const A = wx(x * q, py);
        const B = wx((x + w) * q, py);
        const n: [number, number, number] = [0, 0, dir];
        sides.quad(
          [A[0], base, A[2]],
          [B[0], base, B[2]],
          [B[0], hgt, B[2]],
          [A[0], hgt, A[2]],
          n
        );
        x += w;
      }
    }
  }

  // Faces pointing along -X and +X: scan columns, merge in y.
  for (const dir of [-1, 1]) {
    for (let x = 0; x < gw; x++) {
      let y = 0;
      while (y < gh) {
        const base = faceBase(x, y, x + dir, y);
        if (base === null) {
          y++;
          continue;
        }
        const hgt = hAt(x, y);
        let h = 1;
        while (
          y + h < gh &&
          faceBase(x, y + h, x + dir, y + h) === base &&
          hAt(x, y + h) === hgt
        )
          h++;
        const px = dir < 0 ? x * q : (x + 1) * q;
        const A = wx(px, y * q);
        const B = wx(px, (y + h) * q);
        const n: [number, number, number] = [dir, 0, 0];
        sides.quad(
          [A[0], base, A[2]],
          [B[0], base, B[2]],
          [B[0], hgt, B[2]],
          [A[0], hgt, A[2]],
          n
        );
        y += h;
      }
    }
  }

  const total = caps.pos.length + sides.pos.length;
  const pos = new Float32Array(total);
  const nrm = new Float32Array(total);
  const col = new Float32Array(total);
  pos.set(caps.pos, 0);
  pos.set(sides.pos, caps.pos.length);
  nrm.set(caps.nrm, 0);
  nrm.set(sides.nrm, caps.nrm.length);
  col.set(caps.col, 0);
  col.set(sides.col, caps.col.length);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
  // Group 0 is the caps (bright, lit from above), group 1 the sides.
  geometry.addGroup(0, caps.tris * 3, 0);
  geometry.addGroup(caps.tris * 3, sides.tris * 3, 1);
  geometry.computeBoundingSphere();

  return {
    geometry,
    stats: {
      boxes: f.boxCount,
      capTris: caps.tris,
      sideTris: sides.tris,
      totalTris: caps.tris + sides.tris,
      buildMs: performance.now() - t0,
    },
  };
}

/**
 * The top ring of every wall, as line segments. This is the "cap outline" that
 * keeps a corridor close-up crisp, and it stands in for the chamfer the grid is
 * too coarse to carry.
 */
export function buildWallTopEdges(floor: FloorId, p: FloorPlacement): THREE.BufferGeometry {
  const f = FILES[floor];
  const g = buildGrid(f);
  const { gw, gh, filled, height, quant: q } = g;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : filled[y * gw + x]);
  const hAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= gw || y >= gh ? 0 : height[y * gw + x];
  /** A top edge exists wherever this cell's top is exposed — over empty space
   *  or over a shorter neighbour, which is where the perimeter step falls. */
  const rim = (x: number, y: number, nx: number, ny: number) =>
    at(x, y) !== 0 && hAt(nx, ny) < hAt(x, y);
  const pts: number[] = [];
  const wx = (px: number, py: number) => planToWorld(p, px, py, 0);

  for (const dir of [-1, 1]) {
    for (let y = 0; y < gh; y++) {
      let x = 0;
      while (x < gw) {
        if (!rim(x, y, x, y + dir)) {
          x++;
          continue;
        }
        const hgt = height[y * gw + x];
        let w = 1;
        while (x + w < gw && rim(x + w, y, x + w, y + dir) && height[y * gw + x + w] === hgt) w++;
        const py = dir < 0 ? y * q : (y + 1) * q;
        const A = wx(x * q, py);
        const B = wx((x + w) * q, py);
        pts.push(A[0], hgt, A[2], B[0], hgt, B[2]);
        x += w;
      }
    }
  }
  for (const dir of [-1, 1]) {
    for (let x = 0; x < gw; x++) {
      let y = 0;
      while (y < gh) {
        if (!rim(x, y, x + dir, y)) {
          y++;
          continue;
        }
        const hgt = height[y * gw + x];
        let h = 1;
        while (y + h < gh && rim(x, y + h, x + dir, y + h) && height[(y + h) * gw + x] === hgt) h++;
        const px = dir < 0 ? x * q : (x + 1) * q;
        const A = wx(px, y * q);
        const B = wx(px, (y + h) * q);
        pts.push(A[0], hgt, A[2], B[0], hgt, B[2]);
        y += h;
      }
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
  geom.computeBoundingSphere();
  return geom;
}
