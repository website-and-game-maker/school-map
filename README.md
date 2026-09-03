# Westlake Map

An interactive wayfinding map for Westlake High School — search a room, a place
("Library", "Cafeteria"), or "restroom", and get walking directions drawn on the
real floor plan, across all three levels if it needs stairs.

**Status: v5.** All three floors traced (~280 rooms), routing runs on walls and doorways read
out of the plan itself, so routes are the genuinely shortest sensible walk;
there are turn-by-turn directions with distance and time; and it works on a
phone.

## How it works

The interesting part is how a route is found, because the hand-traced graph the
app started with turned out to be the wrong tool for the job.

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
tools/                     — regenerates nav-*.json from the plan images
```

## Later

Photo walkthroughs along a route, live hallway traffic between passing periods,
and class/teacher search are all still ideas rather than code. The ads idea is
worth a conversation with the school before any of it gets built.
