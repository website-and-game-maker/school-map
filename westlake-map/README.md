# Westlake Map

An interactive wayfinding map for Westlake High School — search a room number (or
"restroom"), get a walking route drawn on the real floor plan, across all three
levels if it needs stairs.

**Status: v3.** All three floors traced (Main, Lower, Upper — ~280 rooms total),
routing works across floors, the drawn route hugs actual hallways instead of
cutting through walls, and there's an in-app editor for fixing hallway paths and
marking restrooms (none are labeled on the source PDF).

## How it works

- The background for each floor is the actual official Westlake floor plan (scanned
  PDF pages, rendered to high-res images) — not redrawn, so it's visually accurate
  from day one.
- Each floor is its own small graph: `points` (rooms, entrances, hallway junctions,
  restrooms) and `edges` (which points are walkably connected), in
  `src/data/floors/{lower,main,upper}.json`. `src/data/floors/stairs.json` lists
  the connections *between* floors.
- Room and hallway-junction positions were traced by eye from the scan (OCR doesn't
  work on it — see below) and are approximate, not surveyed.
- Routing happens in two layers. `src/lib/pathfind.ts` runs Dijkstra over the
  combined 3-floor graph to decide *which* rooms/junctions/stairs the route passes
  through — multiple valid starting points (e.g. "Entrance C" exists on all three
  floors) are wired to a shared virtual start node, so it automatically picks
  whichever floor gets you there with the fewest stairs (same trick for "nearest
  restroom"). Then `src/lib/navmesh.ts` turns that sequence of graph points into
  the line you actually see: it rasterizes a walkable "ribbon" around every edge in
  the graph (a thick capsule the width of a hallway) and runs grid A* through that
  ribbon between each pair of points, instead of just drawing a straight line
  between them. That's what keeps the drawn route inside hallways and off of walls,
  even where a straight line between two graph points would have cut a corner
  through a room. If a route ever looks wrong, the fix is still the graph itself
  (Edit mode, below) — the ribbon is only ever as accurate as the edges you've
  drawn.
- Pan/zoom is `react-zoom-pan-pinch`.

## The staircase problem

The source PDF doesn't mark individual stairwells or elevators. `stairs.json` currently
connects floors at every point where the *same entrance letter* (A/B/C/D) appears on
multiple floor pages — six connections total, all flagged `"verified": false`. That's
a reasonable placeholder (those are real vertical circulation points) but it is a
guess, not a traced fact. If you know where the actual stairwells are, either edit
`stairs.json` by hand (shape: `{id, kind, verified, points: {floorId: pointId}}`,
matching an existing point id per floor it connects) or tell me and I'll place them.

## Editing the map (fixing walls, adding restrooms)

Click **Edit this floor** in the sidebar. Four tools:

- **Move** — click a point to select it (shows an inspector with its id/label and a
  delete button), drag to reposition it.
- **+ Hallway point** — click empty hallway space to drop a new junction where a
  corridor actually bends. Doesn't connect to anything until you use Connect.
- **Connect** — click one point, then another, to add or remove the path between
  them. This is the main tool for fixing "walks through walls": delete the edge
  that cuts through a wall, add junctions that trace the real hallway, connect them.
- **+ Restroom** — click anywhere to drop a restroom pin. Rename it via the
  inspector (e.g. "near 245").

**Saving:** while `npm run dev` is running, **Save \<Floor\>** writes straight back
into `src/data/floors/*.json` (a small Vite dev-only middleware in `vite.config.ts`
handles this — it does nothing in a production build). If the dev server isn't
reachable it falls back to downloading the JSON file, which you'd manually swap in.
Either way, changes only affect the floor you're currently viewing and editing —
save each floor separately.

Panning is disabled while editing (so clicks/drags manipulate the graph, not the
map) — scroll to zoom still works.

## Running it

```
npm install
npm run dev
```

Open the printed localhost URL. `npm run build` produces a static `dist/` you can
host anywhere (Vercel, Netlify, GitHub Pages, the school's own web space) — the
edit-mode *save-to-disk* button only works against `npm run dev`, not that build.

## Extending it

**Add real stair/elevator locations:** see "The staircase problem" above.

**Class name / teacher search:** not built yet (deliberately deferred). Would mean
attaching a schedule/roster data source to rooms — bring the data and I'll wire it up.

**Photo walkthroughs, live traffic, monetization:** all discussed as later ideas,
not started. Worth a conversation with the school before building the ad piece —
see chat history.

## Project structure

```
src/
  App.tsx                — sidebar, search, routing UI, edit-mode UI, floor switcher
  App.css
  types.ts               — FloorData / FloorPoint / FloorEdge / StairLink shapes
  components/MapCanvas.tsx — background image + SVG overlay; also the edit-mode
                              pointer/drag/click handling
  lib/pathfind.ts         — multi-floor Dijkstra (virtual start/end node trick):
                              decides which rooms/junctions/stairs a route passes through
  lib/navmesh.ts          — ribbonizes the graph into a walkable-area grid and runs
                              A* through it, so the drawn line hugs hallways/avoids walls
  lib/save.ts             — save-to-disk (dev) + download-JSON (always) helpers
  data/floors.ts          — wires up the three floors' JSON + images
  data/floors/{lower,main,upper}.json — the actual graphs
  data/floors/stairs.json — cross-floor connectors (see "The staircase problem")
  assets/{lower,main,upper}-level.jpg — traced background images
```
