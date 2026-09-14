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
python3 tools/plans.py <MAPWestlake.pdf>   # render the booklet into private-source/
python3 tools/read_plan.py --apply         # read the room numbers off the plan
python3 tools/export_walls.py              # walls-*.json — the 3D wall geometry
python3 tools/export_rooms.py              # rooms-*.json — room/corridor outlines
python3 tools/export_nav.py                # nav-*.json   — the walkable grid
python3 tools/seed_align.py                # align3d.json — storey placement in 3D
```

Run them in that order: each one downstream reads the room points the one before
it wrote. `tools/plans.py` owns where the scans live and at what resolution —
288 dpi, which is exactly the size the shipped data was built at. Changing it
invalidates `PX_PER_FOOT`, `align3d.json` and every traced point at once.

## What the pieces are

- `src/lib/` — the 2D app's brain. `router.ts` is a grid Dijkstra across all
  three floors; `nav.ts` decodes the walkable grid; `directions.ts` turns a route
  into sentences and owns `PX_PER_FOOT`, the single scale calibration.
  `access.ts` gates the editing tools, `alignment.ts` nudges storeys onto each
  other, `scanReview.ts` surfaces what the plan reader was unsure about, and
  `feedback.ts` turns a sentence of feedback into a prompt.
- `src/three/` — the 3D view. `units.ts` and `placement.ts` are the coordinate
  foundation — `units.ts` also owns the **3D dial**, the single 0..1 number that
  runs storey spacing, camera tilt and ghost opacity; `walls.ts` greedy-meshes
  the wall geometry; `stairColumns.ts` ties the storeys together visibly;
  `viewer.ts` owns the scene and every three.js object.
- `src/data/floors/` — traced room positions, the nav grids, the wall geometry,
  and the per-storey 3D placement.
- `tools/` — the Python that turns the scanned plans into all of the above.

`README.md` in `westlake-map/` explains *why* each of these works the way it
does, in particular how walls are separated from room numbers in the scan. Read
it before changing the extraction.

## Constraints worth knowing

- **Everything derives from a scanned PDF.** There is no vector source: all three
  pages are single greyscale images with no text and no vector paths.
- **OCR is *not* useless on it, which was the old belief and was wrong.** It is
  useless on the raw page, because the room numbers are tangled up with the
  architecture. It works well once each number is isolated, and there is an exact
  way to isolate it: a room's printed number is exactly the set of holes in that
  room's free-space pocket. See `tools/read_plan.py` and the README. Reading
  beats tracing — it caught four rooms on Main whose traced labels were a whole
  room out of step.
- **Room points carry a `source`.** `scan` (read off the drawing, confident),
  `scan-accepted` (a person accepted a low-confidence read), `traced` (placed by
  eye, never confirmed). Do not flatten this away: it is the difference between a
  position that is known and one that is believed.
- **`PX_PER_FOOT = 2.6`** in `src/lib/directions.ts` is that constant. Correct it
  there and nothing else, if anyone ever measures a real distance.
- **Storey alignment is only good to 10–51 ft.** The three sheets are separate
  scans with no registration marks. Every non-reference floor in `align3d.json`
  is `"verified": false`. Do not treat it as ground truth. Edit mode can now nudge
  it by hand, and the stairwell columns are the instrument: a leaning column is
  the registration error drawn at full size.
- **Stairwells and restrooms are not on the plan.** They are marked by hand in
  the app's Edit mode, one marker per stairwell per floor — placing a second one
  nearby moves the first rather than adding a rival, so "which stairwell is this"
  always has one answer. Cross-floor routes are approximate until they are.
- **The 2D and 3D views are one dial, not two modes.** `dimension` runs 0..1:
  flat plan → building at real 16 ft spacing → exploded stack at 110 ft. The 2D
  renderer is what the flat end looks like, and editing lives there because the
  edit overlay is SVG. Do not reintroduce a 2D/3D toggle.

- **The hand-drawn tour map** (`src/assets/tour-map*.jpg`, shown in the app) is a
  student's sketch, not a survey. It is a reference layer, never a data source
  for geometry — but it did independently confirm that all 203 numbered rooms sit
  on the level their number implies (100s lower, 200s main, 300s upper).

## How to continue

Nearest in line, in order:

1. **Work the scan-reader's review queue.** Edit mode lists every read the tool
   was not confident enough to apply, and eight rooms that were removed because
   the drawing positively contradicted them. Each is a couple of clicks. This is
   the highest-value use of ten minutes in the project.
2. **Raise the reader's recall.** It reads 139 of ~215 rooms confidently. The
   misses are mostly small subdivided suites (254x, 257x, 290x) where the text is
   below the glyph-size band, and rooms whose number touches a wall so it is not
   a *hole* in the pocket. A self-calibrating classifier — cluster the glyphs the
   map itself provides, name each cluster by tiling its members into a string
   tesseract can read, then classify the rest by template — was prototyped and is
   the obvious next step; per-glyph OCR on isolated characters is not (it returns
   empty on 60% of them).
3. **Fly-the-route camera and 3D labels** — both designed in detail, neither
   built. The camera is specified as a low drone at ~22 ft, not a first-person
   walk: at eye height you see nothing but wall and lose the room numbers on the
   floor, which are the whole advantage.
4. **Schedule-based routing.** Enter your class periods once and get the day's
   transitions. Page 2 of the tour map is exactly this, hand-drawn by a student,
   which is good evidence it is the feature that would make people who already
   know the building open the app.
5. **Mobile route framing.** The 2D view aims a route at the strip of map the
   bottom sheet leaves visible; the 3D view centres on the whole canvas, so on a
   phone the lower part of a route can sit behind the sheet. The fix is to pass
   the sheet height into the viewer and use `camera.setViewOffset`.

Two bugs that *are* fixed, recorded because the dead ends are worth knowing:

- **Wall-extraction noise** (trees, shrubs, plumbing fixtures extruded as
  walls). Separating them by component *size*, by *thickness*, or by proximity to
  the straight-line skeleton all fail — see the commit message on the fix for the
  measurements. What works is a per-component *shape* test applied before the
  heal, while the artefacts are still free-floating.
- **"All Levels" layering.** Fixed by raising the storey spread to 110 ft.

## Deployment

Pushing to `main` builds and publishes to GitHub Pages automatically, via
`.github/workflows/deploy.yml`. Live at:

  https://website-and-game-maker.github.io/school-map/

The site is a *project* page served from `/school-map/`, so the build needs that
as its base path. The workflow passes it as `VITE_BASE`, derived from the repo
name — `vite.config.ts` defaults to `/` so local dev and any other host still
work. If you rename the repo, the base follows automatically.

The repository is **public**, which is what GitHub Pages requires on a free
account, so the floor plans are publicly readable. Making it private disables the
site unless the account has Pages for private repos.

## Who can edit, and how a change becomes real

Two separate mechanisms, and it matters which one is doing the work.

**What actually protects the map is GitHub, not the app.** The site is static:
there is no server and no session, so nothing a browser does can change what
anyone else sees. The published map is whatever is committed on `main`, and
`main` is protected — a pull request with one approving review is required to
merge. Direct pushes by an admin are still allowed, so the owner is not locked
out of their own project. Collaborators are added under repository Settings →
Collaborators; being a collaborator is what "having access" means.

**The editor key only hides the UI.** `src/lib/access.ts` shows the editing
tools when the key entered into the pencil dialog matches, and remembers it.
`?edit=<key>` still works, because links to it exist, but it is no longer the
only door — a door nobody can see is not a door, and a secret in a URL ends up
screenshotted. The dialog states the key's *shape* before you type, which leaks
nothing against SHA-256 and is the difference between "I mistyped" and "I have
the wrong key". Only the SHA-256 of the key
is baked into the bundle (build-time `VITE_EDIT_KEY_SHA256`, supplied by the
repo variable `EDIT_KEY_SHA256`), so reading the JavaScript does not hand
anybody the key. That is better than a plaintext check and it is still not a
security boundary — a determined person can edit their own copy of the page.
They just cannot make anyone else see it. If the variable is missing the tools
are absent entirely, which is the correct way for this to fail.

**Edits leave as proposals.** "Propose changes" downloads
`proposal-<floor>.json`: the full floor data plus a plain-English list of what
changed, so a reviewer can tell what they are accepting without reading a JSON
diff. To accept one, copy its `data` over `src/data/floors/<floor>.json`, open a
PR, and merge it — the deploy runs on merge. Against `npm run dev` the button
writes the tracked file directly, because that is a maintainer editing their own
checkout; it still has to be committed.

## Repository layout

One repo, `school-map`. `westlake-map/` used to be a nested git repo and is now
flattened in, with its v1–v6 history preserved through the merge. If you are
looking for the old inner `.git`, it was moved to
`~/Desktop/westlake-map-inner-git-backup` and is no longer needed.
