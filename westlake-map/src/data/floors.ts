import type { FloorData, FloorId, StairLink } from "../types";
import { withAutoLinks } from "../lib/autolink";

import mainData from "./floors/main.json";
import lowerData from "./floors/lower.json";
import upperData from "./floors/upper.json";
import stairsData from "./floors/stairs.json";

import mainImg from "../assets/main-level.jpg";
import lowerImg from "../assets/lower-level.jpg";
import upperImg from "../assets/upper-level.jpg";

export const FLOOR_IMAGES: Record<FloorId, string> = {
  lower: lowerImg,
  main: mainImg,
  upper: upperImg,
};

export const FLOOR_ORDER: FloorId[] = ["lower", "main", "upper"];

// Landmarks were traced as points but never connected to a hallway, so they
// get auto-linked to the nearest connected point on load — see lib/autolink.ts.
export const INITIAL_FLOORS: Record<FloorId, FloorData> = {
  lower: withAutoLinks(lowerData as unknown as FloorData),
  main: withAutoLinks(mainData as unknown as FloorData),
  upper: withAutoLinks(upperData as unknown as FloorData),
};

export const INITIAL_STAIRS: StairLink[] = stairsData as unknown as StairLink[];
