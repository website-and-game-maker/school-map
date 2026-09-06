export type FloorId = "lower" | "main" | "upper";

export type PointKind = "room" | "landmark" | "entrance" | "junction" | "poi";

export interface FloorPoint {
  x: number;
  y: number;
  kind: PointKind;
  label?: string;
  poiType?: string; // e.g. "restroom" — only set when kind === "poi"
}

export interface FloorEdge {
  a: string;
  b: string;
  /**
   * True when the app invented this link to attach an otherwise-unconnected
   * point (usually a landmark like the Library) to the nearest hallway. It's a
   * guess — good enough to route with, worth replacing by hand. Shown dashed
   * in Edit mode.
   */
  auto?: boolean;
}

export interface FloorData {
  id: FloorId;
  label: string;
  image: { w: number; h: number };
  points: Record<string, FloorPoint>;
  edges: FloorEdge[];
  entrances: string[];
}

export interface StairLink {
  id: string;
  kind: "stairs" | "elevator";
  verified: boolean;
  points: Partial<Record<FloorId, string>>;
}
