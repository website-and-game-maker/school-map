export type FloorId = "lower" | "main" | "upper";

export type PointKind = "room" | "landmark" | "entrance" | "junction" | "poi";

export interface FloorPoint {
  x: number;
  y: number;
  kind: PointKind;
  label?: string;
  /**
   * Other names this space answers to in search. The plan often gives a room
   * both a number and a name — 106 is the Sub-Varsity Gym, 108 is the Black Box
   * Theater — and somebody looking for it will type whichever one they were
   * told. The label is what gets drawn; the aliases are only ever matched.
   */
  aliases?: string[];
  poiType?: string; // e.g. "restroom" — only set when kind === "poi"
  /**
   * Where this point came from. "scan" means tools/read_plan.py read the number
   * off the plan and was confident; "scan-accepted" means a person accepted a
   * read the tool was not confident about; "traced" means somebody placed it by
   * eye and the scan has never confirmed it. Worth keeping, because it is the
   * difference between a position that is known and one that is believed.
   */
  source?: "scan" | "scan-accepted" | "traced";
  /** The reader's confidence, 0..1, when `source` came from the scan. */
  confidence?: number;
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
