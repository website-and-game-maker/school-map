// What kind of place a named space is, for colouring it the way a street map
// colours parks, food and shops. One list, so the floor fill (floorPlan.ts),
// the label pin (three/labels.ts) and the chips under the search bar can
// never disagree.

export type PlaceCategory = "sports" | "food" | "learning" | "arts" | "office" | "other";

const RULES: Array<[PlaceCategory, RegExp]> = [
  ["sports", /gym|field|stadium|athletic|courtyard/i],
  ["food", /cafeteria|commons|dining|food/i],
  ["learning", /library|research|learning|aep|counsel/i],
  ["arts", /theater|theatre|auditorium|band|choir|arts|performing/i],
  ["office", /admin|office/i],
];

export function placeCategory(name: string): PlaceCategory {
  for (const [cat, re] of RULES) if (re.test(name)) return cat;
  return "other";
}

/** The pin and label colour for each kind: the darker partner of PLACE_FILL, dark
 *  enough to read as text on the white label halo. */
export const PLACE_INK: Record<PlaceCategory, string> = {
  sports: "#188038",
  food: "#c26401",
  learning: "#1967d2",
  arts: "#8430ce",
  office: "#5f6368",
  other: "#188038",
};
