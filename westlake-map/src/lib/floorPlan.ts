// Draws a floor of the school from shapes, not from the scan.
//
// The app used to show the scanned plan page directly — as the image in 2D and
// as the floor texture in 3D. That published the school's original floor plans
// at full resolution to anyone who opened devtools, so the map is now drawn from
// the vector data instead: room and corridor outlines from
// src/data/floors/rooms-*.json, walls from walls-*.json, and room numbers from
// the traced points. Nothing derived from the page pixels ships any more.
//
// One renderer serves both views: 3D uploads the canvas as a texture, 2D draws
// the same canvas into the map pane, so the two can never drift apart.

import type { FloorId } from "../types";

import roomsLower from "../data/floors/rooms-lower.json";
import roomsMain from "../data/floors/rooms-main.json";
import roomsUpper from "../data/floors/rooms-upper.json";
import wallsLower from "../data/floors/walls-lower.json";
import wallsMain from "../data/floors/walls-main.json";
import wallsUpper from "../data/floors/walls-upper.json";

export interface RoomShape {
  id: string;
  label: string;
  kind: "room" | "landmark";
  x: number;
  y: number;
  area: number;
  poly: number[];
  also?: string[];
}

export interface RoomsFile {
  floor: FloorId;
  w: number;
  h: number;
  rooms: RoomShape[];
  corridors: { area: number; poly: number[] }[];
}

interface WallsLite {
  quant: number;
  boxes: number[];
}

const ROOMS: Record<FloorId, RoomsFile> = {
  lower: roomsLower as unknown as RoomsFile,
  main: roomsMain as unknown as RoomsFile,
  upper: roomsUpper as unknown as RoomsFile,
};

const WALLS: Record<FloorId, WallsLite> = {
  lower: wallsLower as unknown as WallsLite,
  main: wallsMain as unknown as WallsLite,
  upper: wallsUpper as unknown as WallsLite,
};

export function roomsOf(floor: FloorId): RoomsFile {
  return ROOMS[floor];
}

/** The palette, kept in step with App.css so the map and the panel agree. */
const INK = {
  paper: "#f4f1ec",
  corridor: "#ffffff",
  room: "#eef1f5",
  landmark: "#e4efe9",
  outline: "#cfc8bd",
  wall: "#8c857a",
  label: "#3a3733",
} as const;

export interface FloorPlanOptions {
  /** Canvas pixels per plan pixel. */
  scale: number;
  /** Draw room numbers. Off for the small ghosted storeys, where they'd be mush. */
  labels?: boolean;
  /** Transparent ground instead of paper, for the 3D plates. */
  transparent?: boolean;
}

/**
 * Render one floor to a fresh canvas, in plan-pixel coordinates scaled by
 * `scale`. The caller owns the canvas.
 */
export function renderFloorPlan(floor: FloorId, opts: FloorPlanOptions): HTMLCanvasElement {
  const { scale, labels = true, transparent = false } = opts;
  const data = ROOMS[floor];
  const walls = WALLS[floor];

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(data.w * scale));
  canvas.height = Math.max(1, Math.round(data.h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  if (!transparent) {
    ctx.fillStyle = INK.paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(scale, scale);

  const path = (flat: number[]) => {
    ctx.beginPath();
    ctx.moveTo(flat[0], flat[1]);
    for (let i = 2; i < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1]);
    ctx.closePath();
  };

  // Circulation first: it is the ground everything else sits on.
  ctx.fillStyle = INK.corridor;
  for (const c of data.corridors) {
    if (c.poly.length >= 6) {
      path(c.poly);
      ctx.fill();
    }
  }

  ctx.lineWidth = Math.max(0.8, 1 / scale);
  ctx.strokeStyle = INK.outline;
  for (const r of data.rooms) {
    if (r.poly.length < 6) continue;
    path(r.poly);
    ctx.fillStyle = r.kind === "landmark" ? INK.landmark : INK.room;
    ctx.fill();
    ctx.stroke();
  }

  // Walls last, over everything, so a room never bleeds across a partition.
  ctx.fillStyle = INK.wall;
  const q = walls.quant;
  const b = walls.boxes;
  for (let i = 0; i < b.length; i += 4) {
    ctx.fillRect(b[i] * q, b[i + 1] * q, b[i + 2] * q, b[i + 3] * q);
  }

  if (labels) {
    ctx.fillStyle = INK.label;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const r of data.rooms) {
      // Below this the number is wider than the room and just makes a smudge.
      if (r.area < 1400) continue;
      const size = r.kind === "landmark" ? 15 : 12;
      ctx.font = `${r.kind === "landmark" ? 600 : 500} ${size}px "Inter", system-ui, sans-serif`;
      ctx.fillText(r.label, r.x, r.y);
    }
  }

  return canvas;
}
