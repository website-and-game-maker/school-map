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

1. **Fly-the-route camera and 3D labels** — both designed in detail, neither
   built. The camera is specified as a low drone at ~22 ft, not a first-person
   walk: at eye height you see nothing but wall and lose the room numbers on the
   floor, which are the whole advantage.
2. **Finish the storey alignment** with a dev-only overlay that nudges
   `align3d.json` by hand. Ten minutes of a human's time closes the biggest
   accuracy gap in the 3D view.
3. **Schedule-based routing.** Enter your class periods once and get the day's
   transitions. Page 2 of the tour map is exactly this, hand-drawn by a student,
   which is good evidence it is the feature that would make people who already
   know the building open the app.
4. **Mobile route framing.** The 2D view aims a route at the strip of map the
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
tools when `?edit=<key>` matches, and remembers it. Only the SHA-256 of the key
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
