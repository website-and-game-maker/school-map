// What kind of place a named space is, for colouring it the way a street map
// colours parks, food and shops. One list, so the floor fill (floorPlan.ts)
// and the label colour (three/labels.ts) can never disagree.

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
