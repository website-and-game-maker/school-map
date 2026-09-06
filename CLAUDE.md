# Westlake Map

An interactive wayfinding map for Westlake High School. Search a room, a place
("Library", "Cafeteria") or "restroom", get walking directions drawn on the real
floor plan across all three levels — in 2D, or in a 3D model of the building
extruded from the same scans.

The app lives in `westlake-map/`. Everything below is run from there unless it
says otherwise.

## Running it

```
cd westlake-map
npm install
npm run dev
```

`npm run build` produces a static `dist/` that hosts anywhere. `npm run lint`
runs oxlint. Typecheck with `npx tsc --noEmit -p tsconfig.app.json` — it is
clean, so any error is new.

Python tooling (only needed to regenerate map data) wants numpy, scipy and
pillow on `python3`:

```
python3 tools/export_nav.py      # nav-*.json   — the walkable grid the router uses
python3 tools/export_walls.py    # walls-*.json — the 3D wall geometry
python3 tools/seed_align.py      # align3d.json — where each storey sits in 3D
```

## What the pieces are

- `src/lib/` — the 2D app's brain. `router.ts` is a grid Dijkstra across all
  three floors; `nav.ts` decodes the walkable grid; `directions.ts` turns a route
  into sentences and owns `PX_PER_FOOT`, the single scale calibration.
- `src/three/` — the 3D view. `units.ts` and `placement.ts` are the coordinate
  foundation; `walls.ts` greedy-meshes the wall geometry; `viewer.ts` owns the
  scene and every three.js object.
- `src/data/floors/` — traced room positions, the nav grids, the wall geometry,
  and the per-storey 3D placement.
- `tools/` — the Python that turns the scanned plans into all of the above.

`README.md` in `westlake-map/` explains *why* each of these works the way it
does, in particular how walls are separated from room numbers in the scan. Read
it before changing the extraction.

## Constraints worth knowing

- **Everything derives from a scanned PDF.** There is no vector source and OCR is
  useless on it. Room positions were traced by eye, so they are approximate, and
  distances are estimates off one calibration constant.
- **`PX_PER_FOOT = 2.6`** in `src/lib/directions.ts` is that constant. Correct it
  there and nothing else, if anyone ever measures a real distance.
- **Storey alignment is only good to 10–51 ft.** The three sheets are separate
  scans with no registration marks. Every non-reference floor in `align3d.json`
  is `"verified": false`. Do not treat it as ground truth.
- **Stairwells and restrooms are not on the plan.** They are marked by hand in
  the app's Edit mode. Cross-floor routes are approximate until they are.
- **The hand-drawn tour map** (`src/assets/tour-map*.jpg`, shown in the app) is a
  student's sketch, not a survey. It is a reference layer, never a data source
  for geometry — but it did independently confirm that all 203 numbered rooms sit
  on the level their number implies (100s lower, 200s main, 300s upper).

## How to continue

Nearest in line, in order:

1. **Wall-extraction noise.** Landscaping symbols in the courtyards and plumbing
   fixtures in small rooms survive the filter in `tools/export_walls.py` and get
   extruded as full-height walls, which reads as glitchy debris in 3D. A size or
   thickness filter alone does not separate them — 25% of real wall pixels are as
   thin as the artefacts, and the biggest connected components already contain
   them. This is the top open bug.
2. **"All Levels" readability.** With three storeys 40 ft apart, one floor's walls
   sit over another floor's paper and you see 2xx and 3xx room numbers on what
   looks like one surface. Either separate the trays much further or stop
   texturing the storeys that are not in focus.
3. **Fly-the-route camera and 3D labels** — both designed, neither built.
4. **Finish the storey alignment** with a dev-only overlay that nudges
   `align3d.json` by hand. Ten minutes of a human's time closes the biggest
   accuracy gap in the 3D view.
5. **Schedule-based routing.** Enter your class periods once and get the day's
   transitions. Page 2 of the tour map is exactly this, hand-drawn by a student,
   which is good evidence it is the feature that would make people who already
   know the building open the app.

## Repository layout

One repo, `school-map`. `westlake-map/` used to be a nested git repo and is now
flattened in, with its v1–v6 history preserved through the merge. If you are
looking for the old inner `.git`, it was moved to
`~/Desktop/westlake-map-inner-git-backup` and is no longer needed.
