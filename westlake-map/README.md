# Westlake Map

An interactive wayfinding map for Westlake High School — search a room, a place
("Library", "Cafeteria"), or "restroom", and get walking directions drawn on the
real floor plan, across all three levels if it needs stairs.

**Status: v4.** All three floors traced (~280 rooms), routing works between any
two points on any floors, routes follow real hallways instead of cutting through
walls, there are turn-by-turn directions with distance and time, and it works on
a phone.

## How it works

The interesting part is how a route gets drawn, because there are two separate
sources of truth and neither is sufficient alone.

**The traced graph** (`src/data/floors/{lower,main,upper}.json`) is a set of
`points` — rooms, entrances, landmarks, hallway junctions, restrooms — and
`edges` saying which are walkably connected. It knows which corridors are
corridors, but its edges are straight lines between hand-placed points, and a
straight line between two points cheerfully crosses walls.

**The walkable masks** (`src/data/floors/walkable-*.json`) are traced from the
scan itself by `tools/walkmask.py`: every pixel that is paper rather than ink,
clipped to the building footprint, downsampled to a 6px grid and bit-packed.
That knows exactly where the walls are, but not which open space is a hallway
you're meant to walk down versus the inside of somebody's classroom.

So routing runs in two layers:

1. `src/lib/pathfind.ts` — Dijkstra over the combined three-floor graph, to
   decide *which* rooms, junctions and staircases a route passes through.
   Multiple valid endpoints (e.g. "Entrance C" exists on all three floors, or
   several restrooms are marked) hang off a shared virtual node, so it picks
   whichever one is genuinely closest.
2. `src/lib/navmesh.ts` — grid A* to decide how the line actually gets *drawn*
   between those points. Walkable space comes from the mask, so the path can't
   cross a wall; cost is biased toward the traced hallways, so it prefers real
   corridors over cutting through a classroom that happens to be open; and it's
   biased toward the middle of a corridor rather than scraping the wall. Where
   the scan shows a door drawn shut, the traced hallway is still usable at a
   heavy cost penalty, so a route never fails just because a doorway isn't drawn
   as a gap.

`src/lib/directions.ts` then turns the drawn path into instructions — merging
slight bends so one corridor is one instruction, and reading turns off the line
you can actually see. Distances come from one calibration constant
(`PX_PER_FOOT`, derived from classroom spacing on the plan); correct it there if
you ever measure a real distance.

## Known-rough bits

**Staircases are a guess.** The source PDF doesn't mark individual stairwells,
so `stairs.json` connects floors at every point where the same entrance letter
appears on multiple floor pages — six links, all flagged `"verified": false`.
Those are real vertical circulation points, but it is a guess. If you know where
the actual stairwells are, edit `stairs.json` (shape:
`{id, kind, verified, points: {floorId: pointId}}`) or say so and I'll place them.

**Landmarks are auto-attached.** Every landmark (Library, Cafeteria, Band Hall,
the Auditorium…) was traced as a point but never wired to a hallway, so
`src/lib/autolink.ts` links each one to the nearest connected point on load.
Those links show dashed orange in Edit mode, and any route using one says so.
Replacing them with real traced hallway is the single highest-value bit of
manual work left.

**Restrooms aren't on the plan at all.** Mark them yourself — see below.

**Positions were traced by eye** from a scanned plan (OCR is useless on it), so
they're approximate, and distances/times are estimates.

## Editing the map

Click **Edit this floor**. Four tools:

- **Move** — click a point to select it (inspector shows its id and a delete
  button), drag to reposition.
- **+ Hallway point** — click empty hallway space to drop a junction where a
  corridor actually bends. Connect it up afterwards.
- **Connect** — click one point, then another, to add or remove the path between
  them. This is how you replace a dashed auto-link with a real hallway.
- **+ Restroom** — click anywhere to drop a restroom pin; rename it in the
  inspector (e.g. "near 245"). Once any restroom exists, searching "restroom"
  routes to the closest one.

**Saving:** while `npm run dev` is running, **Save \<Floor\>** writes straight
back into `src/data/floors/*.json` (a dev-only Vite middleware in
`vite.config.ts`; it does nothing in a production build). Otherwise it falls back
to downloading the JSON for you to swap in. Save each floor separately.

Panning is disabled while editing so clicks manipulate the graph; scroll still
zooms.

## Running it

```
npm install
npm run dev
```

`npm run build` produces a static `dist/` you can host anywhere (Vercel, Netlify,
GitHub Pages, the school's own web space). The edit-mode save-to-disk button only
works against `npm run dev`.

To regenerate the walkable masks (only needed if the plan images change):

```
python3 tools/walkmask.py --all
```

## Project structure

```
src/
  App.tsx                  — search, routing, directions panel, floor switcher,
                             edit UI; sidebar on desktop, bottom sheet on phone
  App.css
  types.ts                 — FloorData / FloorPoint / FloorEdge / StairLink
  components/
    MapCanvas.tsx          — plan image + SVG overlay: route, arrows, pins,
                             restrooms, and edit-mode interaction
    SearchBox.tsx          — autocomplete with keyboard nav, used for both ends
  lib/
    pathfind.ts            — multi-floor Dijkstra: which points a route uses
    navmesh.ts             — grid A* over real walkable space: how it's drawn
    walkable.ts            — decodes the bit-packed masks
    directions.ts          — turn-by-turn steps, distance, time
    search.ts              — one index over rooms/entrances/landmarks/restrooms
    autolink.ts            — attaches unconnected landmarks to the nearest hallway
    save.ts                — save-to-disk (dev) + download-JSON helpers
  data/
    floors.ts              — wires up floors, images, auto-links
    floors/{lower,main,upper}.json      — the traced graphs
    floors/walkable-*.json              — wall masks from the scan
    floors/stairs.json                  — cross-floor connectors
tools/walkmask.py          — regenerates the wall masks from the plan images
```

## Later

Photo walkthroughs along a route, live hallway traffic between passing periods,
and class/teacher search are all still ideas rather than code. The ads idea is
worth a conversation with the school before any of it gets built.
