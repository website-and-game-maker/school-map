# Westlake Map

An interactive wayfinding map for Westlake High School — search a room number, get a
walking route drawn right on the real floor plan. Built for freshmen and visitors who
get lost, and for anyone who wants to find a new way through the halls.

**Status: v1 prototype.** Main Level only, ~100 rooms, routing works. Lower Level,
Upper Level, and the features below are next.

## How it works

- The background is the actual official Westlake floor plan (scanned PDF, rendered to
  a high-res image) — not a redrawn map, so it's visually accurate from day one.
- An invisible graph of hallway junctions + room positions sits on top of it
  (`src/data/mainLevel.json`). Room coordinates were traced by eye from the scan (OCR
  didn't work — it's a low-quality fax-era scan with almost no machine-readable text)
  and are approximate, not surveyed. If a marker looks off, nudge its `[x, y]` in that
  file (pixel coordinates on the 3167×2448 source image) or tell me and I'll fix it.
- Routing is plain Dijkstra over that graph (`src/lib/pathfind.ts`) — small graph
  (~130 nodes), so no need for anything fancier.
- Pan/zoom is `react-zoom-pan-pinch`.

## Running it

```
npm install
npm run dev
```

Then open the printed localhost URL. `npm run build` produces a static `dist/`
folder you can host anywhere (Vercel, Netlify, GitHub Pages, or the school's own
web space).

## Extending it

**Add a floor (Lower/Upper Level):** same recipe as Main Level —
1. Render that PDF page to a high-res PNG/JPG, drop it in `src/assets/`.
2. Trace room + corridor-junction coordinates into a JSON file shaped like
   `src/data/mainLevel.json` (an LLM reading cropped close-ups of the scan is what
   actually produced the Main Level one — tedious by hand, but doable).
3. Wire up the floor switcher in `App.tsx` (currently stubbed — Lower/Upper buttons
   are disabled placeholders) to swap the background image + data + graph.
4. Add stairwell/elevator nodes that connect matching hallway junctions *between*
   floor graphs, so a route can span floors.

**Roadmap discussed with Saahir (2026-09-03):**
- Photo walkthroughs along a route (imagery of hallways, not just lines)
- Live/reported hallway traffic between passing periods
- Class name / teacher search (so you can search "AP Bio" instead of a room number)
- Possibly a login (for security) — deliberately out of scope for now
- Possible monetization: paid advertising placements on the map — worth thinking
  through with the school before building, since it's their building and their
  students seeing it.

## Project structure

```
src/
  App.tsx           — the whole UI: sidebar, search, map, routing
  App.css
  lib/pathfind.ts    — Dijkstra over the hallway graph
  data/mainLevel.json — rooms, landmarks, corridor nodes, edges (Main Level only)
  assets/main-level.jpg — the traced background image
```
