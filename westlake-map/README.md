# Westlake Map

An interactive wayfinding map for Westlake High School — search a room, a place
("Library", "Cafeteria"), or "restroom", and get walking directions drawn on the
real floor plan, across all three levels if it needs stairs.

**Status: v7.** All three floors mapped (~215 rooms), routing runs on walls and
doorways read out of the plan itself, so routes are the genuinely shortest
sensible walk; there are turn-by-turn directions with distance and time; and it
works on a phone.

New in v7:

- **The room numbers are read off the plan by machine** rather than traced by
  eye — see *Reading the plan* below. This found four rooms on the Main level
  whose labels were a whole room out of step, so asking for 220 walked you to
  218.
- **One 3D dial instead of two view modes.** Flat plan → building → exploded
  stack, on a slider, and 3D is what you get on arrival.
- **Stairwell columns** tie each stairwell through the storeys, so the stack
  reads as one building — and a leaning column is the floor alignment being
  wrong, drawn at full size.
- **A pencil in the corner** asks for the editor key, instead of the key living
  in the URL.
- **Feedback that is literally a prompt** you can hand to a coding agent.

## How it works

Two interesting parts: how a route is found, and how a scanned PDF became a
3D model of the school.

## The tilt dial

One vertical slider, bottom right of the map. It swings the camera between
looking straight down and looking across, and it does nothing else.

It used to also open and close the storey stack — "Flat / Building / Exploded"
— on the theory that a plan and an exploded diagram are two ends of one
continuum. They are, but tying them to one control meant the building changed
shape while you were changing your viewpoint, and a model that reshapes itself
under you is one you stop trusting. Worse, the flat end swapped renderers, so
pushing the slider all the way down jumped to a differently-scaled view of a
different thing. The stack is now simply always open and the dial is a camera
control; the two ends of it are the same model at the same scale.

The 2D renderer still exists, and editing is the one thing that uses it: the
points, the drag handles and the click targets live in an SVG overlay, which is
a 2D thing.

**The floor picks itself.** From the route you asked for, and from the storey
you orbit onto — the storey nearest the orbit target wins, with a dead zone so
a target sitting between two floors does not flip back and forth. The stack of
chips at the top right is the readout for that, ordered the way the floors
actually are, and clicking one is an override rather than the main way in.

**Stairwell columns** join each stairwell through every storey it serves, same
colour at both ends. Three floor plates floating above one another look like
three separate maps; what makes them read as one building is seeing the parts
that pass through all of it. Guessed links (seeded from entrance names) are
pale and translucent, links from human-placed markers are solid.

That also makes the alignment honest: where two storeys are badly registered
the column visibly **leans**, and the lean is the registration error at full
size. It is the instrument you read while using the align nudges in Edit mode.

**The site.** Sky with a real horizon, a ground that fades into it, and the
building's own footprint laid on that ground beneath the stack. Without them the
model floated in a flat void, which reads as unsettling rather than as neutral:
with no horizon and no ground there is nothing in the picture that has a size,
so the eye cannot place the building in a world. See `src/three/site.ts`.

## Reading the plan

Every room position in this project used to be placed by a human clicking on the
scan. That is slow, and it is wrong in ways nobody can see. On the Main level the
points for 216, 218, 220 and 224 each sat one room short of the number they
claimed — the point calling itself 220 was inside the room printed 218 — so the
app confidently walked you to the wrong door and nothing in the pipeline could
notice, because nothing in the pipeline ever looked at the number.

`tools/read_plan.py` looks at the number. The idea that makes it work is small:

> **A room's printed number is exactly the set of holes in its pocket.**

`export_rooms.py` already establishes that these plans draw every door *closed*,
so flooding the free space gives one sealed pocket per room. Fill that pocket's
holes and subtract the pocket back off, and what is left is precisely the ink
printed inside that room and touching nothing else: the number, and nothing but
the number.

That is the whole trick, and it matters because of what it replaces. The obvious
approach — isolate text by subtracting the long-line wall skeleton, then filter
for "text-like" components — was tried first and it mangles the glyphs: the line
opening eats the vertical stroke of every `1` and clips the `4`s, because those
*are* long straight runs. The pocket-hole test never touches a glyph. What comes
out is a clean 42×27 crop of isolated digits, which is a thing OCR can read.

The rest is bookkeeping:

- **Dominant text size.** A room may hold a fixture symbol or a door tag as well
  as its number. Keep the glyphs whose height matches the median — the number is
  the largest text drawn inside a room.
- **Rotation.** Narrow rooms have their number set vertically, which the crop's
  aspect ratio gives away. Both rotations are tried and the grammar decides.
- **Voting.** No single rendering of this stencil font is trustworthy; the same
  crop reads `288C` at one scale and `2B8C` at another, because tesseract has no
  prior that says a room number is mostly digits. Each crop goes through twelve
  renderings — two scales × stroke-thickening on/off × three page-segmentation
  modes — and reads matching the room-number grammar are weighted double. The
  agreement across renderings is the confidence.
- **Grammar.** `[1-4]\d\d[A-Z]?`, gated on the digits that storey actually uses
  (100s lower, 200s main, 300s *and* 400s upper — the gyms and the PAC are 4xx).
  A `283` read off the Upper sheet is a misread, not a room on the wrong floor.
- **Position from geometry, never from OCR.** A room's anchor is its pocket's
  *pole of inaccessibility* — the interior point furthest from any wall. It is
  inside the room by construction and sits in open floor, which is where a route
  should end. A traced point sits wherever the tracer clicked, which is usually
  on the number and sometimes on a wall.

**It reports, it does not overwrite.** Every room comes out tagged `confirmed`
(scan and data agree), `corrected` (they disagree), `found` (a number in a pocket
nothing claimed) or `unread`. Measured across all three sheets, every read that
turned out to be a misread scored ≤ 0.33 and every correction that held up under
inspection scored ≥ 0.50 — a real gap, which is what makes the 0.5 apply
threshold defensible rather than a guess.

Applying is a whole-floor rebuild, not a per-point patch. Patching in place would
relabel 216 to "214" while the point already called 214 kept its name, and the
floor would end up with two of them; the shift only resolves if the numbered set
is rebuilt at once from the reads. Everything below the threshold goes into a
review queue **inside the app** — Edit mode, *The scan isn't sure about these* —
where each one is a place on the map you can jump to, look at, and accept with a
click. Results:

| Floor | Confirmed | Corrected | Newly found | Left for review |
| --- | --- | --- | --- | --- |
| Lower | 11 | 2 | 6 | 31 |
| Main | 38 | 13 | 14 | 47 |
| Upper | 35 | 7 | 13 | 21 |

```
python3 tools/plans.py MAPWestlake.pdf   # render the booklet into private-source/
python3 tools/read_plan.py               # report only, writes nothing
python3 tools/read_plan.py --apply       # act on the confident reads
python3 tools/read_plan.py --render main # + a PNG of every read, for eyeballing
```

`tools/plans.py` is also the single place that knows where the scans live and
what resolution they are. They render at 4× the PDF's user space — 288 dpi —
because that is exactly the pixel size the shipped floor data was built at, so
`PX_PER_FOOT`, `align3d.json` and every traced point survive a rebuild. The tools
used to each name their own input file and disagree about it (`main-level.jpg`
vs `page0.png`), so renaming one silently broke the other.

## What is a wall

The map is drawn from geometry, not from the scan, so something has to decide
which ink is architecture. That decision used to be **"a wall is a long
straight run of ink"**, separated from annotation by a multi-orientation line
opening. It cannot tell a wall from anything else long and straight, and these
drawings are full of long straight things that are not walls — so the published
map drew **every door standing open**, drew the fixtures inside the small suites
as a field of unreadable fragments, and passed the stems of the room numbers
through as little wall stubs.

The definition is now:

> **A wall is ink with a different space on each side of it.**

Label the free space, throw away the pockets too small to be a room, and mark
the ink that has two different surviving labels within 11 px. A door swing arc
is drawn *inside* one room, so it is near exactly one space and vanishes. So do
the furniture, the fixtures and the text. A wall has a room on one side and a
corridor on the other, so it stays.

The size filter is not an arbitrary threshold. The counter of a printed `0` is a
pocket of free space too — the ring of the glyph genuinely does separate the
inside of the 0 from the room around it — so without a minimum size the digits
with closed loops survive as little rings. Requiring a space to be room-sized
(600 px, the same number `export_rooms.py` uses) removes them by saying what we
actually mean: **a wall divides places you can stand.**

### Drawn as lines, not as pixels

The mask's boundary is rectilinear by construction — every step is one pixel —
so a wall the scanner nudged half a pixel comes out as a staircase, and drawing
that literally is what made the map look pixelated. `wall_outlines()` traces the
mask and runs three passes over each ring:

1. **Douglas–Peucker**, to drop the single-pixel steps.
2. **Merge near-parallel neighbours.** A long wall the scan bent by a couple of
   degrees halfway along arrives as two edges; this is the pass that answers
   *"if a line is straight and gets bumped, ignore the bump"*.
3. **Snap and re-cut.** Edges within 7° of an axis or a 45 are made exact, and
   the corners are re-cut as the intersection of the snapped lines. The building
   is drawn on a square grid, so an edge 2° off vertical is a scanning artefact
   every time. A corner that lands more than 6 px from where the pixels put it
   means the snap was wrong for that edge, and the traced corner is kept.

The 3D view still extrudes the quantised rectangles — that is the right shape
for a mesh. The 2D map draws the polygons.

### The footprint

Grown off the **storey mask**, not off the walls. It used to come from the
walls, which worked while a wall was a thick restored line-opening: the
dilate/fill/erode closed over the gaps and the result was the building.
Separator walls are thinner, and the same steps then read most of the interior
as "far from any wall" and carved it away as courtyard — Upper came out as a
single 76-point scrap instead of four wings.

### Known gap: the courtyard planting

Chap Court's trees still come out as wall, and the reason is that the rule above
is working correctly. A tree is drawn as a scalloped ring; the inside of that
ring is a genuine pocket of free space; so the ring really does separate two
spaces. Four ways of telling it from a wall were measured on these sheets and
each one fails:

| approach | why it fails |
| --- | --- |
| component shape (the shrub filter this file already had) | the planting is welded into the courtyard edging at every stage of the mask, so it is never the free-floating blob that filter needs |
| a bigger cap for that filter | the clump is 47k px, and a cap that admits it also drops 149k px of real wall |
| boundary straightness | tree pockets average a 10.4 px edge; real small rooms run 7.7–9.4 |
| axis alignment | the Black Box / Sub-Varsity wing is drawn at 45° and scores 0.05 where the trees score 0.29 |

It is two shapes in one courtyard on one sheet, and every fix tried so far costs
more of the building than it saves. Left as it is, on purpose, and recorded here
so the next person does not repeat the search.

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

**Most positions are now read off the plan; the rest were traced by eye.** Every
room point carries a `source` — `scan` when `tools/read_plan.py` read its number
off the drawing and was confident, `scan-accepted` when a person accepted a read
the tool was unsure about, `traced` when somebody placed it by eye and the scan
has never confirmed it. Distances and times are estimates from one scale
constant either way.

**Eight rooms are missing rather than wrong.** Where the scan positively
contradicted a traced point — the pocket it sat in is printed with a different
number — and the reader could not read that room anywhere else, the point was
removed. A point the drawing says is somewhere else is worse than no point at
all: it sends people to a specific wrong door, confidently. They are listed in
Edit mode under *The scan isn't sure about these*.

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

Panning works while editing. It used to be switched off, which meant the map
froze the moment you started editing and you could not drag to see the part of
the floor you wanted to fix. Dragging a point still moves the point rather than
the map, because the point's own `pointerdown` stops the event before the
pan handler sees it.

**One stair marker per floor.** Clicking **+ Stairs** near a marker you already
placed on this floor moves it instead of adding a rival. Two markers 30 ft apart
on Main cannot both be the bottom of the same flight, and if both are kept the
cross-floor matching has to guess which one Upper's marker pairs with.

**Aligning the floors.** *How the floors line up* in the edit panel nudges the
active storey — position, scale, rotation — and the 3D view re-registers live.
Main is the reference and does not move. Slide the dial to Exploded and nudge
until the stairwell columns stand up straight. Ten minutes of this closes the
largest accuracy gap in the 3D view; it leaves as `proposal-align3d.json`, or
writes `align3d.json` directly under `npm run dev`.

**Reporting something wrong.** *Report something wrong* takes a sentence in
plain English and turns it into a prompt: your words quoted verbatim, plus the
floor, the coordinates, the nearby traced points, and the handful of facts about
this repository needed to act on it. Copy it into Claude Code, open it as a
prefilled GitHub issue, or save the `.md`. The panel shows you the whole prompt
before you send it anywhere — the app is speaking on your behalf and you should
be able to read what it says.

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
