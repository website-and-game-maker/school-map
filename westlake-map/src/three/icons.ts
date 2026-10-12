// Small white glyphs for the coloured place pins, 24x24 viewBox. Simple
// shapes on purpose: at 11px a detailed icon is a smudge, and what reads at a
// glance is the pin's colour, which comes from placeCategory.ts.

import type { PlaceCategory } from "../lib/placeCategory";

export const ICON_PATHS: Record<PlaceCategory, string> = {
  sports: "M3 9h2.5v6H3zM18.5 9H21v6h-2.5zM6.5 6.5H9v11H6.5zM15 6.5h2.5v11H15zM9 10.75h6v2.5H9z",
  other: "M12 2l6.5 9H15l4.5 6.5H13V22h-2v-4.5H4.5L9 11H5.5z",
  learning: "M4 4.5h6.5c.8 0 1.5.7 1.5 1.5v14c-.4-.6-1-1-1.8-1H4zM20 4.5h-6.5c-.8 0-1.5.7-1.5 1.5v14c.4-.6 1-1 1.8-1H20z",
  food: "M6 2h1.5v6.5H8.5V2H10v6.5H11V2h1.5v7.5c0 1.2-.8 2.2-2 2.5V22H8.5V12c-1.2-.3-2-1.3-2.5-2.5zM16.5 2C18.5 2 20 4.5 20 8.5c0 2.5-1 3.8-2 4.2V22h-2V2z",
  arts: "M9.5 3H20v4.5h-8V17a3.5 3.5 0 11-2.5-3.35z",
  office: "M10.75 10h2.5v9h-2.5zM10.75 5h2.5v2.5h-2.5z",
};

const NS = "http://www.w3.org/2000/svg";

export function categoryIcon(cat: PlaceCategory): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICON_PATHS[cat]);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}
