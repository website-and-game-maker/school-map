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
