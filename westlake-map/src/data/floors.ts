import type { FloorData, FloorId, StairLink } from "../types";

import mainData from "./floors/main.json";
import lowerData from "./floors/lower.json";
import upperData from "./floors/upper.json";
import stairsData from "./floors/stairs.json";


export const FLOOR_ORDER: FloorId[] = ["lower", "main", "upper"];

export const INITIAL_FLOORS: Record<FloorId, FloorData> = {
  lower: lowerData as unknown as FloorData,
  main: mainData as unknown as FloorData,
  upper: upperData as unknown as FloorData,
};

export const INITIAL_STAIRS: StairLink[] = stairsData as unknown as StairLink[];
