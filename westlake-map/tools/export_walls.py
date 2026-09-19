"""Turn the scanned floor plans into 3D wall geometry.

Three problems have to be solved before a page can be extruded:

1. WHAT IS A WALL.  Walls, door swings, furniture, hatching and room-number text
   all land in the same ink. A wall is a long straight run of ink and a "234" is
   not, so a multi-orientation LINE OPENING separates them. The opening also
   nicks real walls, so the surviving skeleton is dilated back to thickness
   (intersected with the ink, which can never invent geometry) and closed to
   heal the nicks.

2. WHAT IS ON THIS STOREY.  Every page draws the *other* storeys too, as bare
   outlines with a "(Upper Level)" caption, and the lower-level page also draws
   the roads and parking lots of the whole site. Extruding those would fill the
   model with ghost boxes. The tell is interior detail: a real room on this
   storey has door swings, fixtures and partitions, i.e. lots of ink that is NOT
   long straight lines. Local density of that short ink seeds a storey mask, and
   the seeds are then gated on the room points the app already knows for this
   floor (src/data/floors/{floor}.json), which throws away the seeds that are
   really just a caption sitting inside a ghost outline.

3. CHEAP GEOMETRY.  The wall mask is quantised to QUANT plan px and decomposed
   into axis-aligned rectangles by greedy run merging, so the client can build
   one merged BufferGeometry from a flat integer array.

Outputs src/data/floors/walls-{floor}.json. Run from the repo root:

    /opt/homebrew/bin/python3 tools/export_walls.py            # all floors
    /opt/homebrew/bin/python3 tools/export_walls.py --render   # + verification PNGs
"""
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

import plans

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The source scans deliberately do NOT live under src/: anything in there is
# bundled and published. They sit in private-source/, which is gitignored, so
# the pipeline can still be re-run locally while nothing derived from the page
# pixels ever reaches the browser.
ASSETS = os.path.join(ROOT, 'private-source')
OUT_DIR = os.path.join(ROOT, 'src', 'data', 'floors')
SCRATCH = ('/private/tmp/claude-501/-Users-saahir-Desktop-School-Map/'
           'c6960bd9-1f4d-4c5c-9470-39ee0824be17/scratchpad')

FLOORS = ('lower', 'main', 'upper')

# --- stage 1: ink + page footprint (identical to tools/mask4.py) --------------
DARK = 170
SPECK = 6
FOOTPRINT_DILATE = 14

# --- stage 2: long-line skeleton ---------------------------------------------
LINE_LEN = 31            # line-opening length in px; measured best of 21..45
LINE_ANGLES = range(0, 180, 15)
HATCH_WIN = 121          # px window for the orientation-dominance test
HATCH_BEST = 0.045       # min density of same-angle ruling in that window
HATCH_INK = 0.070        # min total ink density (several strokes, not one wall)
HATCH_CROSS = 0.25       # max cross-orientation response, as a share of `best`
HATCH_CORE = 15          # erosion that demands a broad field, not a ribbon
HATCH_AREA = 40000       # px of that eroded core needed to call it a hatch field

# --- stage 3: which part of the page is actually this storey ------------------
DETAIL_WIN = 121         # px window for the short-ink density
DETAIL_T = 0.020         # density above this seeds "real storey"
SEED_LINK = 30           # closing iterations that join seeds across a storey
ROOM_REACH = 45          # a seed must come this close to a known room point
STOREY_GROW = 22         # dilate the storey out over its own perimeter walls

# --- stage 4: wall / annotation separation -----------------------------------
RESTORE_ITERS = 3        # dilate(lines) & inside -> puts wall thickness back
HEAL = 9                 # closing kernel that reconnects walls the opening tore
MIN_BLOB_PX = 600        # a surviving piece must have this area ...
MIN_BLOB_DIM = 45        # ... or this bbox extent, else it is leftover lettering
NET_LINK = 22            # px gap bridged when grouping walls into one building
# Free-floating blobs: trees and shrubs in the courtyards, plumbing fixtures in
# the small rooms. They pass the line opening (a shrub outline contains straight
# runs) and they survive a size filter (some are large), so they are caught by
# SHAPE instead -- compact, roughly as tall as wide, and solidly filled, which no
# run of wall ever is. Only components that touch nothing else are eligible, so a
# real wall can never qualify: it is attached to the rest of the building.
BLOB_AREA = 6000         # px; bigger free-floating things are kept
BLOB_ELONG = 3.0         # max bbox aspect ratio to count as a blob
BLOB_FILL = 0.18         # min area / bbox area; wall runs come in far below this

# --- stage 5: rectangle decomposition ----------------------------------------
QUANT = 2                # plan px per rectangle cell (2 keeps walls near true width)

# --- stage 6: footprint polygons ---------------------------------------------
FP_DOWN = 4              # trace the footprint at 1/4 scale, then scale back up
DP_TOL = 3.0             # Douglas-Peucker tolerance, plan px
MIN_HOLE_PX = 90000      # enclosed voids smaller than this are rooms, not courts
MIN_PART_PX = 120000     # a detached wing smaller than this is not a slab
SLAB_DILATE = 24         # gap the slab bridges around big rooms and doorways
SLAB_SEAL = 22           # closing that heals slab channels cut by wide doorways


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- stage 1 ----
def ink_and_footprint(path):
    a = np.array(Image.open(path).convert('L'))
    ink = a < DARK
    lab, n = ndi.label(ink, structure=np.ones((3, 3)))
    if n:
        sizes = ndi.sum(ink, lab, range(1, n + 1))
        ink &= ~np.isin(lab, np.nonzero(sizes < SPECK)[0] + 1)
    ink = ndi.binary_closing(ink, structure=np.ones((3, 3)))
    fat = ndi.binary_dilation(ink, np.ones((3, 3)), iterations=FOOTPRINT_DILATE)
    fp = ndi.binary_fill_holes(fat)
    fp = ndi.binary_erosion(fp, np.ones((3, 3)), iterations=FOOTPRINT_DILATE)
    lab, n = ndi.label(fp)
    if n > 1:
        sizes = ndi.sum(fp, lab, range(1, n + 1))
        fp = lab == int(np.argmax(sizes)) + 1
    return a, ink, fp


def largest(mask):
    lab, n = ndi.label(mask)
    if n <= 1:
        return mask
    sizes = ndi.sum(mask, lab, range(1, n + 1))
    return lab == int(np.argmax(sizes)) + 1


# ---------------------------------------------------------------- stage 2 ----
def line_se(angle_deg, length):
    """A 1px-wide straight line of `length` px at `angle_deg`, as a bool array."""
    th = np.deg2rad(angle_deg)
    dx, dy = np.cos(th), np.sin(th)
    t = np.linspace(-(length - 1) / 2.0, (length - 1) / 2.0, length * 3)
    xs = np.rint(t * dx).astype(int)
    ys = np.rint(t * dy).astype(int)
    r = max(int(np.abs(xs).max()), int(np.abs(ys).max()))
    se = np.zeros((2 * r + 1, 2 * r + 1), bool)
    se[ys + r, xs + r] = True
    return se


def long_lines(mask, length=LINE_LEN):
    """Union of the per-angle line openings, and the per-angle masks themselves."""
    per = [ndi.binary_opening(mask, structure=line_se(ang, length))
           for ang in LINE_ANGLES]
    out = np.zeros_like(mask)
    for o in per:
        out |= o
    return out, per


def hatch_mask(ink_in_page, per):
    """Fields of parallel ruling that mean "this bay belongs to another storey".

    Inside such a field every stroke runs the same way, so the line-opening
    response at one orientation is strong and the response 45 deg or more away
    is nil -- unlike a real plan, where partitions cross corridors. The field
    also has to be broad and ink-dense, which is what separates it from a lone
    long exterior wall.
    """
    D = np.stack([ndi.uniform_filter(o.astype(np.float32), HATCH_WIN) for o in per])
    best, arg = D.max(0), D.argmax(0)
    na = len(per)
    cross = np.zeros_like(best)
    for i in range(na):
        far = np.stack([D[j] for j in range(na)
                        if min(abs(i - j), na - abs(i - j)) >= 3])
        cross = np.where(arg == i, far.max(0), cross)
    inkd = ndi.uniform_filter(ink_in_page.astype(np.float32), HATCH_WIN)
    cand = (best > HATCH_BEST) & (inkd > HATCH_INK) & (cross < HATCH_CROSS * best)
    cand = ndi.binary_fill_holes(
        ndi.binary_closing(cand, np.ones((3, 3)), iterations=10))
    cand = ndi.binary_erosion(cand, np.ones((3, 3)), iterations=HATCH_CORE)
    lab, n = ndi.label(cand)
    if n:
        sz = ndi.sum(cand, lab, range(1, n + 1))
        cand = np.isin(lab, np.nonzero(sz >= HATCH_AREA)[0] + 1)
    return ndi.binary_dilation(cand, np.ones((3, 3)), iterations=HATCH_CORE + 14)


# ---------------------------------------------------------------- stage 3 ----
def room_points(floor):
    """Plan-pixel centres of the rooms this floor is known to contain."""
    path = os.path.join(OUT_DIR, f'{floor}.json')
    if not os.path.exists(path):
        return []
    d = json.load(open(path))
    return [(p['x'], p['y']) for p in d.get('points', {}).values()
            if p.get('kind') == 'room']


def storey_mask(ink_in_page, lines, pts, shape):
    """The part of the page that really is this storey.

    Short ink -- door swings, fixtures, small partitions -- only appears where
    the storey is drawn for real. Ghost outlines of other levels, roads and
    parking lots have none. Captions do, so a seed only counts if a known room
    point of this floor falls in it.
    """
    h, w = shape
    detail = ink_in_page & ~ndi.binary_dilation(lines, np.ones((3, 3)), iterations=2)
    dens = ndi.uniform_filter(detail.astype(np.float32), DETAIL_WIN)
    seed = dens > DETAIL_T
    lab, n = ndi.label(seed)
    if n and pts:
        marks = np.zeros(shape, bool)
        for x, y in pts:
            marks[max(0, int(y) - 1):int(y) + 2, max(0, int(x) - 1):int(x) + 2] = True
        marks = ndi.binary_dilation(marks, np.ones((3, 3)), iterations=ROOM_REACH)
        keep = sorted(set(np.unique(lab[marks & seed]).tolist()) - {0})
        seed = np.isin(lab, keep)
    m = ndi.binary_closing(seed, np.ones((3, 3)), iterations=SEED_LINK)
    m = ndi.binary_fill_holes(m)
    return ndi.binary_dilation(m, np.ones((3, 3)), iterations=STOREY_GROW)


# ---------------------------------------------------------------- stage 4 ----
def drop_small(mask, min_area, min_dim):
    """Remove connected pieces that are both small in area and short in extent."""
    lab, n = ndi.label(mask, structure=np.ones((3, 3)))
    if not n:
        return mask
    sizes = ndi.sum(mask, lab, range(1, n + 1))
    objs = ndi.find_objects(lab)
    dims = np.array([max(o[1].stop - o[1].start, o[0].stop - o[0].start)
                     for o in objs])
    bad = np.nonzero((sizes < min_area) & (dims < min_dim))[0] + 1
    return mask & ~np.isin(lab, bad) if len(bad) else mask


def keep_networks(walls, pts, min_share=0.06):
    """Drop wall pieces that belong to no building.

    Bridging the mask by NET_LINK px glues a wing's walls into one network. A
    network is kept if a known room of this floor sits in it, or if it holds a
    decent share of the storey's wall ink (a wing whose rooms are all unnamed).
    Road edges and parking-lot kerbs that survived this far belong to neither.
    """
    net = ndi.binary_dilation(walls, np.ones((3, 3)), iterations=NET_LINK)
    lab, n = ndi.label(net)
    if n <= 1:
        return walls
    sizes = ndi.sum(walls, lab, range(1, n + 1))
    marks = np.zeros(walls.shape, bool)
    for x, y in pts:
        marks[max(0, int(y) - 1):int(y) + 2, max(0, int(x) - 1):int(x) + 2] = True
    marks = ndi.binary_dilation(marks, np.ones((3, 3)), iterations=ROOM_REACH)
    hit = set(np.unique(lab[marks]).tolist()) - {0}
    total = max(1.0, float(walls.sum()))
    keep = [i + 1 for i in range(n)
            if (i + 1) in hit or sizes[i] / total >= min_share]
    return walls & np.isin(lab, keep)


def drop_blobs(mask, verbose=False):
    """Remove free-floating compact blobs -- furniture, fixtures, planting.

    Run this BEFORE the heal. The closing that reconnects torn walls also welds
    a nearby shrub onto the wall next to it, and once welded it is part of the
    building's one big component and no per-component test can see it any more.
    """
    lab, n = ndi.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return mask
    sizes = ndi.sum(mask, lab, range(1, n + 1)).astype(int)
    kill = []
    for i, sl in enumerate(ndi.find_objects(lab)):
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        area = int(sizes[i])
        elong = max(h, w) / max(1, min(h, w))
        # Fill is measured on the component with its holes filled, not on the
        # ink. A tree is drawn as a RING, so its ink covers only a fifth of its
        # bounding box and it used to pass this test as "not solid" — while the
        # thing the test is trying to describe, "a compact lump sitting on its
        # own", is exactly what a filled ring is.
        solidified = ndi.binary_fill_holes(lab[sl] == i + 1)
        fill = int(solidified.sum()) / max(1, h * w)
        if elong < BLOB_ELONG and area < BLOB_AREA and fill > BLOB_FILL:
            kill.append(i + 1)
    if not kill:
        return mask
    out = mask & ~np.isin(lab, kill)
    if verbose:
        log(f'    dropped {len(kill)} free-floating blobs '
            f'({int(mask.sum() - out.sum())} px, '
            f'{100 * (mask.sum() - out.sum()) / max(1, mask.sum()):.1f}% of wall ink)')
    return out


# A space has to be at least this big to count as a room or a corridor, which
# is what makes it able to have a wall between it and its neighbour. Matches
# MIN_ROOM_PX in export_rooms.py on purpose: the two files should not disagree
# about what a space is.
MIN_SPACE_PX = 600
# How far apart two spaces may be and still have a wall between them. Sized to
# the thickest wall on these sheets; larger and a door swing drawn across a
# corner starts to "separate" the room from the corridor it opens onto.
SEPARATOR_WIN = 11
# Put the wall's core back after classification. The window test only marks ink
# that is close to BOTH spaces, so the middle of a thick wall comes out hollow.
SOLIDIFY = 2
# Bridge the one- and two-pixel breaks the scan leaves along a wall. Kept well
# below a doorway's width (15-25 px) so real openings stay open -- the plans
# draw doors closed, and a doorway drawn as a gap is a doorway, not a defect.
HEAL_SMALL = 5


def separator_walls(inside, free, page_fp, st, verbose=True):
    """A wall is ink with a different space on each side of it.

    KNOWN GAP, measured, so nobody repeats the search: Chap Court's planting
    still comes out as wall. A tree is drawn as a scalloped ring and the inside
    of that ring is a genuine pocket of free space, so the ring really does
    separate two spaces and this test keeps it, correctly by its own lights.
    Four ways of telling it from a wall were tried and each one fails on
    measurements from these sheets:

      * component shape (the filter this file already has for shrubs): the
        planting is welded into the courtyard edging at every stage of the
        mask, so it is never the free-floating blob that filter needs;
      * a bigger cap for that filter, on the theory that the planting is just a
        large blob: the clump is 47k px, and a cap that admits it also drops
        149k px of real wall;
      * boundary straightness: tree pockets average a 10.4 px edge and real
        small rooms run 7.7-9.4, so no threshold separates them;
      * axis alignment: the Black Box / Sub-Varsity wing is drawn at 45 degrees
        and scores 0.05 where the trees score 0.29.

    It is two shapes in one courtyard on one sheet, and every fix tried so far
    costs more of the building than it saves.


    This is the definition, and everything the old one got wrong follows from
    it not having one. Before this, a wall was "a long straight run of ink",
    separated from annotation by a multi-orientation line opening. That test
    cannot tell a wall from anything else long and straight, and these drawings
    are full of long straight things that are not walls:

      * door leaves and their swing arcs, which is why every door on the
        published map was drawn standing open,
      * the fixtures and partitions inside the small suites, which came out as
        a field of fragments nobody could read,
      * the room numbers themselves, whose stems pass a 31px opening.

    Each of those sits INSIDE one space. A wall, by contrast, has a room on one
    side and a corridor on the other. So: label the free space, throw away the
    pockets too small to be a room, and mark the ink that has two different
    surviving labels within SEPARATOR_WIN. A door arc is near exactly one room
    and vanishes; a wall is near two and stays.

    The one subtlety is the size filter, and it is not an arbitrary threshold.
    The counter of a printed "0" is a pocket of free space too — the ring of the
    glyph genuinely does separate the inside of the 0 from the room around it —
    so without a minimum size the digits with closed loops survive as little
    rings. Requiring a space to be room-sized removes them by saying what we
    actually mean: a wall divides places you can stand.
    """
    lab, n = ndi.label(free, structure=np.ones((3, 3)))
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    h, w = lab.shape

    big = sizes >= MIN_SPACE_PX
    big[0] = False

    spaces = np.where(big[lab], lab, 0).astype(np.int32)
    # Outside the storey is a space as well — it is what the exterior wall has
    # on its far side, and without it the whole perimeter fails the test.
    outside = np.int32(n + 1)
    spaces[~st] = outside
    spaces[~page_fp] = outside

    sentinel = np.iinfo(np.int32).max
    lo = ndi.minimum_filter(np.where(spaces > 0, spaces, sentinel), size=SEPARATOR_WIN)
    hi = ndi.maximum_filter(np.where(spaces > 0, spaces, 0), size=SEPARATOR_WIN)
    sep = inside & (lo != sentinel) & (hi != 0) & (lo != hi)

    if SOLIDIFY:
        sep = ndi.binary_dilation(sep, np.ones((3, 3)), iterations=SOLIDIFY) & inside

    # Blobs first, closing second, and the order is load-bearing: the closing
    # welds a shrub onto the wall it is standing next to, and once welded it is
    # part of the building's one big component and no per-component test can
    # see it any more.
    walls = drop_blobs(sep, verbose)
    walls = ndi.binary_closing(walls, structure=np.ones((HEAL_SMALL, HEAL_SMALL))) & inside
    walls = drop_small(walls, MIN_BLOB_PX, MIN_BLOB_DIM)
    if verbose:
        ni = max(1, int(inside.sum()))
        log(f'    storey ink {ni}  spaces {int(big.sum())}  '
            f'separators {100*sep.sum()/ni:.1f}%  walls {100*walls.sum()/ni:.1f}%')
    return walls


# ---------------------------------------------------------------- stage 5 ----
def quantise(mask, q):
    """Downsample by `q` with OR pooling (a cell is wall if any px in it is)."""
    h, w = mask.shape
    H, W = (h + q - 1) // q, (w + q - 1) // q
    pad = np.zeros((H * q, W * q), bool)
    pad[:h, :w] = mask
    return pad.reshape(H, q, W, q).any(axis=(1, 3))


def to_rects(cells):
    """Greedy run-merge: horizontal runs per row, then merge identical runs down."""
    H, _ = cells.shape
    boxes = []
    open_runs = {}          # (x0, x1) -> y0
    for y in range(H):
        row = cells[y].astype(np.int8)
        d = np.diff(np.concatenate(([0], row, [0])))
        cur = set(zip(np.flatnonzero(d == 1).tolist(),
                      np.flatnonzero(d == -1).tolist()))
        for key in list(open_runs):
            if key not in cur:
                x0, x1 = key
                y0 = open_runs.pop(key)
                boxes.append((x0, y0, x1 - x0, y - y0))
        for key in cur:
            if key not in open_runs:
                open_runs[key] = y
    for (x0, x1), y0 in open_runs.items():
        boxes.append((x0, y0, x1 - x0, H - y0))
    return boxes


def rects_to_mask(boxes, shape):
    m = np.zeros(shape, bool)
    for x, y, w, h in boxes:
        m[y:y + h, x:x + w] = True
    return m


# ---------------------------------------------------------------- stage 6 ----
def trace_loops(mask):
    """All boundary loops of a binary mask, as lists of (x, y) corner points.

    A directed unit edge is emitted around every filled pixel on the sides where
    the neighbour is empty, all wound the same way; chaining them yields closed
    rectilinear loops, outer rings and holes coming out with opposite winding.
    """
    h, w = mask.shape
    p = np.zeros((h + 2, w + 2), bool)
    p[1:-1, 1:-1] = mask
    core = p[1:-1, 1:-1]
    sides = [(core & ~p[:-2, 1:-1], (0, 0), (1, 0)),      # top
             (core & ~p[1:-1, 2:], (1, 0), (1, 1)),       # right
             (core & ~p[2:, 1:-1], (1, 1), (0, 1)),       # bottom
             (core & ~p[1:-1, :-2], (0, 1), (0, 0))]      # left
    nxt = {}
    for m, (ax, ay), (bx, by) in sides:
        ys, xs = np.nonzero(m)
        for y, x in zip(ys.tolist(), xs.tolist()):
            nxt.setdefault((x + ax, y + ay), []).append((x + bx, y + by))

    loops = []
    for start in list(nxt.keys()):
        while nxt.get(start):
            loop = [start]
            cur = start
            while True:
                outs = nxt.get(cur)
                if not outs:
                    break
                nx = outs.pop()
                if not outs:
                    nxt.pop(cur, None)
                loop.append(nx)
                cur = nx
                if cur == start:
                    break
            if len(loop) > 4:
                loops.append(loop[:-1])
    return loops


def signed_area(pts):
    x = np.array([p[0] for p in pts], float)
    y = np.array([p[1] for p in pts], float)
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def dp_simplify(pts, tol):
    """Douglas-Peucker over an open polyline (feed a ring with its first point
    repeated at the end)."""
    n = len(pts)
    if n < 4:
        return pts
    P = np.array(pts, float)
    keep = np.zeros(n, bool)
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = P[i], P[j]
        seg = b - a
        L = float(np.hypot(*seg))
        sub = P[i + 1:j]
        if L < 1e-9:
            d = np.hypot(sub[:, 0] - a[0], sub[:, 1] - a[1])
        else:
            d = np.abs(seg[0] * (a[1] - sub[:, 1]) - (a[0] - sub[:, 0]) * seg[1]) / L
        k = int(np.argmax(d))
        if d[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return [pts[i] for i in np.flatnonzero(keep)]


# --- smoothing: turn a pixel boundary back into drawn lines -------------------
# The mask's boundary is rectilinear by construction — every step is one pixel,
# so a wall that the scanner nudged half a pixel comes out of trace_loops as a
# staircase. Drawing that literally is what made the published map look
# pixelated. These two numbers undo it.
SMOOTH_TOL = 2.2      # px a vertex may move during Douglas-Peucker
SNAP_DEG = 7.0        # an edge this close to an axis or a 45 is made exact
MERGE_DEG = 8.0       # consecutive edges within this of each other become one
MIN_EDGE = 3.0        # px; shorter edges are jitter, not corners


def _snap_angle(dx, dy):
    """Nearest of the eight cardinal/diagonal directions, if one is close."""
    ang = math.degrees(math.atan2(dy, dx))
    for target in range(-180, 181, 45):
        if abs((ang - target + 180) % 360 - 180) <= SNAP_DEG:
            r = math.radians(target)
            return math.cos(r), math.sin(r)
    return None


def straighten(ring):
    """Simplify a traced ring into clean lines, ignoring scanner bumps.

    Three passes, each doing one job:

      1. Douglas-Peucker, to drop the single-pixel staircase steps.
      2. Merge runs of edges that point the same way. A long wall that the scan
         bent by a couple of degrees halfway along arrives as two edges; this is
         the pass that answers "if a line is straight and gets bumped, ignore
         the bump".
      3. Snap near-axis edges to exactly axial and re-cut the corners as the
         intersection of the snapped lines. The building is drawn on a square
         grid, so an edge 2 degrees off vertical is a scanning artefact every
         time, and leaving it off-square is what reads as wobble.
    """
    pts = dp_simplify(list(ring) + [ring[0]], SMOOTH_TOL)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 3:
        return []

    # --- 2: merge near-parallel neighbours -----------------------------------
    n = len(pts)
    merged = []
    i = 0
    while i < n:
        a = pts[i]
        j = (i + 1) % n
        b = pts[j]
        adv = 1
        while adv < n:
            k = (i + adv + 1) % n
            c = pts[k]
            a1 = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
            a2 = math.degrees(math.atan2(c[1] - b[1], c[0] - b[0]))
            if abs((a1 - a2 + 180) % 360 - 180) > MERGE_DEG:
                break
            b = c
            adv += 1
        merged.append(a)
        i += adv
        if len(merged) > n:
            break
    pts = merged if len(merged) >= 3 else pts

    # --- 3: snap to the drawing's own grid, then re-cut the corners ----------
    m = len(pts)
    lines = []          # (point on line, unit direction)
    for i in range(m):
        a = pts[i]
        b = pts[(i + 1) % m]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        if L < 1e-9:
            lines.append(None)
            continue
        snapped = _snap_angle(dx, dy)
        ux, uy = snapped if snapped else (dx / L, dy / L)
        mid = ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
        lines.append((mid, (ux, uy)))

    out = []
    for i in range(m):
        cur = lines[i]
        prev = lines[(i - 1) % m]
        if cur is None or prev is None:
            out.append(pts[i])
            continue
        (px, py), (pux, puy) = prev
        (cx, cy), (cux, cuy) = cur
        det = pux * (-cuy) - puy * (-cux)
        if abs(det) < 1e-6:
            out.append(pts[i])          # parallel: keep the traced corner
            continue
        rx, ry = cx - px, cy - py
        t = (rx * (-cuy) - ry * (-cux)) / det
        ix, iy = px + pux * t, py + puy * t
        # A snapped corner that lands far from the traced one means the snap was
        # wrong for this edge; trust the pixels rather than the grid.
        if math.hypot(ix - pts[i][0], iy - pts[i][1]) > 6.0:
            out.append(pts[i])
        else:
            out.append((ix, iy))

    # drop the hairs left behind by snapping
    clean = []
    for pt in out:
        if not clean or math.hypot(pt[0] - clean[-1][0], pt[1] - clean[-1][1]) >= MIN_EDGE:
            clean.append(pt)
    if len(clean) >= 3 and math.hypot(clean[0][0] - clean[-1][0],
                                      clean[0][1] - clean[-1][1]) < MIN_EDGE:
        clean.pop()
    return clean if len(clean) >= 3 else []


def wall_outlines(walls):
    """Every wall boundary as a smoothed polygon, for the 2D map to draw.

    The 3D view extrudes the quantised rectangles, which is the right shape for
    a mesh. The 2D view should not: at map scale those rectangles are visibly
    stepped, and a floor plan drawn in steps looks like a mistake rather than
    like a plan.
    """
    out = []
    for ring in trace_loops(walls):
        poly = straighten(ring)
        if len(poly) < 3:
            continue
        if abs(signed_area(poly)) < 24:
            continue
        out.append([int(round(v)) for xy in poly for v in xy])
    return out


def storey_footprint(walls, st):
    """Solid slab of the storey (one mask, possibly several detached wings).

    Grown off the STOREY mask, not off the walls. It used to come from the
    walls, which worked while a "wall" was a thick restored line-opening: the
    dilate/fill/erode closed over the gaps and the result was the building.
    Separator walls are thinner and sparser, and the same steps then read most
    of the interior as "far from any wall" and carved it away as courtyard --
    Upper came out as a single 76-point scrap instead of four wings.

    The storey mask is the right base anyway: it already answers "which part of
    this page is this floor", which is the question a footprint asks.
    """
    solid = ndi.binary_closing(st, np.ones((3, 3)), iterations=SLAB_SEAL)
    solid = ndi.binary_fill_holes(solid)
    lab, n = ndi.label(solid)
    if n:
        sizes = ndi.sum(solid, lab, range(1, n + 1))
        solid = np.isin(lab, np.nonzero(sizes >= MIN_PART_PX)[0] + 1)
    # Re-open the genuine courtyards the hole fill just closed. A courtyard is
    # a large void with no walls in it; a big room is a large void WITH walls
    # around and across it, which is why this is measured against the walls.
    voids = solid & ~ndi.binary_dilation(walls, np.ones((3, 3)), iterations=SLAB_DILATE)
    voids &= ~st          # a courtyard is not part of the storey to begin with
    lab, n = ndi.label(voids)
    if n:
        sizes = ndi.sum(voids, lab, range(1, n + 1))
        big = np.nonzero(sizes >= MIN_HOLE_PX)[0] + 1
        if len(big):
            solid = solid & ~np.isin(lab, big)
    return solid


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            xc = x0 + (y - y0) * (x1 - x0) / float(y1 - y0)
            if xc > x:
                inside = not inside
    return inside


def footprint_parts(solid):
    """Slab outlines in plan px: one part per detached wing, each with holes."""
    small = ndi.binary_erosion(quantise(solid, FP_DOWN), np.ones((3, 3)))
    loops = trace_loops(small)
    if not loops:
        return []
    scored = sorted(((abs(signed_area(l)), signed_area(l), l) for l in loops),
                    key=lambda t: -t[0])
    out_sign = np.sign(scored[0][1])
    q2 = FP_DOWN * FP_DOWN
    # `solid` was already component-filtered, so keep every outer ring it has
    outers = [l for a, sg, l in scored if np.sign(sg) == out_sign and a * q2 >= 2000]
    holes = [l for a, sg, l in scored if np.sign(sg) != out_sign and a * q2 >= MIN_HOLE_PX]

    def finish(loop):
        pts = [(x * FP_DOWN, y * FP_DOWN) for x, y in loop]
        pts = dp_simplify(pts + [pts[0]], DP_TOL)
        if len(pts) > 1 and pts[0] == pts[-1]:
            pts = pts[:-1]
        return pts

    parts = [{'outer': finish(o), 'holes': [], '_raw': o} for o in outers]
    for hl in holes:
        owner, best = None, None
        for pt in parts:
            if point_in_ring(hl[0], pt['_raw']):
                a = abs(signed_area(pt['_raw']))
                if best is None or a < best:
                    owner, best = pt, a
        if owner is not None:
            owner['holes'].append(finish(hl))
    for pt in parts:
        pt.pop('_raw')
    return parts


# ------------------------------------------------------------------ build ----
def build(floor, verbose=True):
    t0 = time.time()
    grey, ink, page_fp = ink_and_footprint(plans.page_path(floor))
    ink_in_page = ink & page_fp
    lines, per_ang = long_lines(ink_in_page)
    hatch = hatch_mask(ink_in_page, per_ang)

    pts = room_points(floor)
    st = storey_mask(ink_in_page, lines, pts, grey.shape) & ~hatch
    inside = ink_in_page & st
    if verbose:
        h, w = grey.shape
        log(f'    storey {100*st.sum()/(h*w):.1f}% of page, holds '
            f'{100*inside.sum()/max(1,ink_in_page.sum()):.1f}% of the page ink, '
            f'{sum(1 for x,y in pts if st[min(h-1,int(y)), min(w-1,int(x))])}'
            f'/{len(pts)} known rooms')

    free = (~ink) & page_fp & st
    walls = separator_walls(inside, free, page_fp, st, verbose=verbose)
    before = int(walls.sum())
    walls = keep_networks(walls, pts)
    if verbose and walls.sum() != before:
        log(f'    network filter kept {100*walls.sum()/max(1,before):.1f}% of wall px')

    cells = quantise(walls, QUANT)
    boxes = to_rects(cells)
    recon = rects_to_mask(boxes, cells.shape)
    cov = 100.0 * (recon & cells).sum() / max(1, cells.sum())
    full = np.kron(recon, np.ones((QUANT, QUANT), bool))[:walls.shape[0], :walls.shape[1]]
    inflate = 100.0 * full.sum() / max(1, walls.sum())

    outlines = wall_outlines(walls)
    solid = storey_footprint(walls, st)
    parts = footprint_parts(solid)
    log(f'  {floor}: {len(boxes)} boxes, {len(outlines)} outlines, cells {cov:.1f}%, '
        f'quantised area {inflate:.0f}% of wall px, footprint parts '
        f'{[(len(p["outer"]), [len(h) for h in p["holes"]]) for p in parts]} '
        f'({time.time()-t0:.1f}s)')
    return dict(grey=grey, ink=ink, storey=st, inside=inside, walls=walls,
                cells=cells, boxes=boxes, outlines=outlines, solid=solid, parts=parts)


def write_json(floor, r):
    h, w = r['grey'].shape
    flat = []
    for b in r['boxes']:
        flat.extend(int(v) for v in b)
    doc = {
        'floor': floor,
        'w': int(w), 'h': int(h),
        'quant': QUANT,
        'pxPerFoot': 2.6,
        'boxCount': len(r['boxes']),
        'boxes': flat,
        # Drawn by the 2D map. The boxes above are for extrusion; these are the
        # same walls as smooth polygons, because a plan drawn in quantised
        # rectangles reads as pixelated at map scale.
        'outlines': r['outlines'],
        'footprint': [
            {'outer': [int(v) for p in part['outer'] for v in p],
             'holes': [[int(v) for p in hole for v in p] for hole in part['holes']]}
            for part in r['parts']
        ],
    }
    out = os.path.join(OUT_DIR, f'walls-{floor}.json')
    with open(out, 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    kb = os.path.getsize(out) / 1024.0
    log(f'  {floor}: wrote {out}  {kb:.1f} KB')
    return out, kb


# ----------------------------------------------------------------- render ----
def _mask_img(m):
    return Image.fromarray(np.where(m, 0, 255).astype(np.uint8)).convert('RGB')


def render(floor, r):
    os.makedirs(SCRATCH, exist_ok=True)
    h, w = r['grey'].shape
    recon = np.kron(rects_to_mask(r['boxes'], r['cells'].shape),
                    np.ones((QUANT, QUANT), bool))[:h, :w]
    orig = Image.fromarray(r['grey']).convert('RGB')
    rec = _mask_img(recon)
    a = np.array(rec)
    a[r['solid'] & ~recon] = [222, 232, 244]      # slab, where no wall stands
    rec = Image.fromarray(a)

    # footprint outline drawn over the reconstruction
    from PIL import ImageDraw
    fpim = rec.copy()
    dr = ImageDraw.Draw(fpim)
    for part in r['parts']:
        dr.line([tuple(p) for p in part['outer']] + [tuple(part['outer'][0])],
                fill=(220, 40, 40), width=5)
        for hole in part['holes']:
            dr.line([tuple(p) for p in hole] + [tuple(hole[0])],
                    fill=(40, 90, 220), width=5)

    outs = []
    scale = 1500.0 / w
    ow, oh = int(w * scale), int(h * scale)
    canvas = Image.new('RGB', (ow * 2 + 12, oh), 'white')
    canvas.paste(orig.resize((ow, oh), Image.LANCZOS), (0, 0))
    canvas.paste(fpim.resize((ow, oh), Image.LANCZOS), (ow + 12, 0))
    p = os.path.join(SCRATCH, f'walls-{floor}-full.png')
    canvas.save(p)
    outs.append(p)

    # 1:1 crops of the densest classroom areas
    dens = ndi.uniform_filter(r['inside'].astype(np.float32), size=201)
    d = dens.copy()
    CW = CH = 560
    spots = []
    for _ in range(3):
        cy, cx = divmod(int(np.argmax(d)), w)
        spots.append((max(0, min(w - CW, cx - CW // 2)),
                      max(0, min(h - CH, cy - CH // 2))))
        d[max(0, cy - 520):cy + 520, max(0, cx - 520):cx + 520] = -1
    for i, (x0, y0) in enumerate(spots):
        box = (x0, y0, x0 + CW, y0 + CH)
        c = Image.new('RGB', (CW * 2 + 10, CH), 'white')
        c.paste(orig.crop(box), (0, 0))
        c.paste(rec.crop(box), (CW + 10, 0))
        p = os.path.join(SCRATCH, f'walls-{floor}-crop{i+1}.png')
        c.save(p)
        outs.append(p)
    log('  rendered: ' + ', '.join(os.path.basename(o) for o in outs))
    return outs


if __name__ == '__main__':
    args = sys.argv[1:]
    do_render = '--render' in args
    floors = [a for a in args if not a.startswith('-')] or list(FLOORS)
    total = 0.0
    for fl in floors:
        log(f'  {fl}: reading {os.path.relpath(plans.page_path(fl), ROOT)}')
        r = build(fl)
        total += write_json(fl, r)[1]
        if do_render:
            render(fl, r)
    log(f'total JSON {total:.1f} KB')
