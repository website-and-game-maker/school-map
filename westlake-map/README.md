# Westlake Map

An interactive wayfinding map for Westlake High School — search a room, a place
("Library", "Cafeteria"), or "restroom", and get walking directions drawn on the
real floor plan, across all three levels if it needs stairs.

**Status: v6.** All three floors traced (~280 rooms), routing runs on walls and doorways read
out of the plan itself, so routes are the genuinely shortest sensible walk;
there are turn-by-turn directions with distance and time; and it works on a
phone. New in v6: a **3D view** of the actual building, extruded from the same
scans, with the route drawn through it.

## How it works

Two interesting parts: how a route is found, and how a scanned PDF became a
3D model of the school.

## The 3D view

Switch with **2D Plan / 3D View** at the top of the panel.

**The walls are the building's real walls.** `tools/export_walls.py` pulls them
out of the same scans the router uses. The hard part is that the plan's ink is
not all architecture — it is also 216 room numbers, "LIBRARY", the school crest,
and landscaping hatch, and extruding those gives you ten-foot-tall numerals
standing in the middle of classrooms. Walls are separated from annotation by a
multi-orientation *line opening*: a straight structuring element is swept at 12
angles, and only ink that contains a long straight run in some direction
survives. Measured on the Main sheet, the knee is at length 31 — at 25 the room
numbers are still legible in the output, at 39 the partitions in the rotated 254
wing start breaking up. What survives is restored to full wall thickness, small
gaps are healed, and the result is decomposed into ~4-10k disjoint rectangles
per floor (`src/data/floors/walls-*.json`, 295 KB for all three).

**The geometry is greedy-meshed, not one box per rectangle.** `src/three/walls.ts`
emits a vertical face only where a filled cell meets an empty one, merges
collinear runs into long quads, and merges the top surface into maximal
rectangles. Faces *between* touching rectangles are never generated. That is
~178k triangles for the whole school in about 80 ms per floor, in roughly 22
draw calls. Walls near the outside are 13.5 ft and interior partitions 10.5 ft,
which is what makes the model read as a building with a boundary rather than a
maze.

**The floor is the scan itself.** Each storey's plate is the traced footprint,
UV-mapped to that floor's page, so all 216 room numbers stay readable from
above and nothing has to be re-labelled in 3D. Textures are downscaled off the
main thread and only the focused storey gets the high-resolution copy.

**The stack opens and closes as you orbit.** You cannot see into a building from
outside, so the storeys separate to 40 ft when the camera is well above the
horizon and collapse to a realistic 16 ft as you come down to eye level. The
floor tabs gain an **All**; picking a single floor hides the storeys above it
and drops the ones below to a muted plate.

**Routes are lifted, not redrawn.** The same `GridRoute` the 2D view draws
becomes a mitred ribbon — a wide translucent halo, a white casing and a dashed
teal core, mirroring the 2D CSS — with a rung ladder wherever it changes floor.
Distances in 3D and 2D come from the same numbers, so they always agree.

**Floor registration is the rough part.** The three sheets are separate scans at
different scales with no registration marks, so where each storey sits relative
to the others is inferred. `tools/seed_align.py` fits scale and translation from
the entrances the sheets share, with rotation pinned to 0, then nudges onto the
wall structure. Residuals are 10-51 ft — good enough to read as one building,
not good enough to trust, which is why every non-reference floor in
`src/data/floors/align3d.json` is `"verified": false`. Registering the wall or
footprint *masks* by correlation was tried and is worse, and the reason is
recorded in `placement.ts`: the storeys genuinely differ in extent, so
maximising overlap slides one storey inside the other's mass. It put the shared
entrances 220-400 ft apart.

## Routing

**The walls come from the scan.** `tools/mask4.py` reads each plan page and
works out what's standable: ink is wall, paper is floor, clipped to the building
footprint. The catch is that these plans draw every door *closed* — at full
resolution not one classroom connects to a corridor. But a door is drawn as a
notch in the wall, so the wall is thinnest exactly where the door is, and
carving each enclosed room through its thinnest wall lands on the real doorway.
That found ~840 doors across the three floors and is what makes 85-91% of rooms
reachable at all.

**Routing runs on that, not on the graph.** `src/lib/router.ts` runs Dijkstra
over a 6px grid where a step is legal only if there's no ink between the two
cell centres — so a route physically cannot cross a wall. Corridors are cheap,
the inside of a labelled classroom is ~3x, so a route stays in the halls and
enters a room only to arrive. Floors are joined by stair links and solved in
one search, so a route takes whichever staircase actually gets you there
fastest.

`src/lib/directions.ts` turns the drawn line into instructions, merging slight
bends so one corridor is one instruction. Distances come from one calibration
constant (`PX_PER_FOOT`, derived from classroom spacing on the plan) — correct
it there if you ever measure a real distance.

The traced point graph in `src/data/floors/*.json` is still what gives rooms,
entrances and landmarks their names and positions. It no longer decides where
routes go.

## Known-rough bits

**Staircases still need marking, and that's the one thing worth your ten
minutes.** Four ways of finding them automatically were tried and none is
trustworthy on this scan: the treads are ~2px apart and merge into a grey hatch;
dense-texture detection can't tell a stair run from a room number; filtering by
circulation space fails because stairwells are enclosed; and matching small
enclosed pockets across floors produces mostly coincidence. So `stairs.json`
still holds the old guess — floors joined at every shared entrance letter, all
flagged `"verified": false`.

Instead, **+ Stairs** in Edit mode lets you mark a stairwell on each floor it
serves. Markers that land at the same physical spot are linked into one
stairwell automatically (floors are aligned to each other using the entrances,
which are the one feature traced on more than one page). Those links count as
verified and the router prefers them.

**Restrooms aren't on the plan at all.** Mark them the same way.

**Positions were traced by eye** from a scanned plan (OCR is useless on it), so
they're approximate, and distances/times are estimates.

**On a phone, the 3D camera doesn't know about the bottom sheet.** The 2D view
aims a route at the strip of map the sheet leaves visible; the 3D view centres
it on the whole canvas, so on a narrow screen the lower part of a route can sit
behind the sheet. The fix is to pass the sheet height into the viewer and use
`camera.setViewOffset`; it is not done because it could not be tested on a real
phone here.

## Editing the map

Click **Edit this floor**. Hallways don't need drawing any more — the walls come
from the plan itself — so what's left is the things the plan doesn't record:

- **Move** — click a point to select it (inspector shows its id and a delete
  button), drag to reposition. Use it if a room label sits in the wrong place.
- **+ Stairs** — click a stairwell. Mark the same one on each floor it serves
  and they link automatically.
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

To regenerate the navigation data (only needed if the plan images change):

```
python3 tools/export_nav.py
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
    nav.ts                 — decodes the bit-packed navigation grids
    router.ts              — the router: grid Dijkstra across floors
    directions.ts          — turn-by-turn steps, distance, time
    search.ts              — one index over rooms/entrances/landmarks/restrooms
    floorAlign.ts          — fits a transform between floor pages via entrances
    stairsFromMarks.ts     — links stair markers across floors
    save.ts                — save-to-disk (dev) + download-JSON helpers
  data/
    floors.ts              — wires up floors and images
    floors/{lower,main,upper}.json      — names and positions (not routing)
    floors/nav-*.json                   — walkable space traced from the scans
    floors/stairs.json                  — the old guessed cross-floor links
  three/
    units.ts               — world units (1 unit = 1 foot), axes, storey heights,
                             and the orbit-driven storey spread
    placement.ts           — where each storey sits in one shared site frame
    walls.ts               — walls-*.json -> one merged mesh per floor
    slab.ts                — footprint -> textured floor plate + edge
    textures.ts            — the plan scans as floor textures
    routeLift.ts           — GridRoute -> one 3D polyline, stair risers included
    routeObject.ts         — ribbons, stair ladders, start/end markers
    theme.ts               — palette, materials, easing
    viewer.ts              — the scene, lighting, floor states, render loop
  components/
    MapCanvas3D.tsx        — the React bridge (React owns no three.js object)
  data/floors/
    walls-{lower,main,upper}.json  — wall rectangles + footprint polygons
    align3d.json                   — per-storey placement
tools/
  export_nav.py            — regenerates nav-*.json from the plan images
  export_walls.py          — regenerates walls-*.json
  seed_align.py            — regenerates align3d.json
```

## Later

Nearest in line for the 3D view: a **fly-the-route** camera (a low drone at ~22
ft, not a first-person walk — at eye height you would see nothing but wall and
lose the room numbers on the floor, which are the whole advantage), **labels**
for landmarks and entrances, and a **dev-only alignment overlay** so the storey
registration can be finished by hand in about ten minutes.

Further out: photo walkthroughs along a route, live hallway traffic between
passing periods, and class/teacher search. The ads idea is worth a conversation
with the school before any of it gets built.
