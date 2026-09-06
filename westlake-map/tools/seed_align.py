#!/usr/bin/env python3
"""Derive src/data/floors/align3d.json by registering wall masks, not entrances.

The three plan sheets are separate scans at different scales with no shared
registration marks. arch.md's seed values were fit from the 2-3 entrance points
each pair of floors has in common, which is 4-6 numbers to constrain 3 unknowns
and gave 25-47 ft of residual. walls-*.json gives us something far stronger: a
clean per-floor mask of where the building's walls actually are, ~4-10k
rectangles per floor. Registering mask-to-mask uses tens of thousands of
constraints instead of six.

Method: rasterise each floor's wall boxes into an occupancy grid in `main`'s
pixel frame, sweep uniform scale (rotation is pinned to 0 -- see arch.md 2), and
for each scale solve the translation exactly by FFT cross-correlation over every
integer offset. Score with Dice so a bigger scale can't win just by covering
more area. Coarse pass at 4 px/cell, refine at 2 px/cell.

Usage:  python3 tools/seed_align.py            # search + write align3d.json
        python3 tools/seed_align.py --render   # also write overlay PNGs
"""

import json
import os
import sys

import numpy as np
from scipy.ndimage import gaussian_filter
from scipy.signal import fftconvolve

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FLOORS_DIR = os.path.join(ROOT, "src", "data", "floors")
OUT_DIR = os.environ.get("ALIGN_OUT", "/tmp")

REF = "main"
MOVING = ["lower", "upper"]


def load_walls(floor):
    with open(os.path.join(FLOORS_DIR, "walls-%s.json" % floor)) as fh:
        return json.load(fh)


def rasterise(walls, scale, res):
    """Wall boxes -> bool grid, `res` plan px per grid cell, after uniform `scale`.

    Boxes are in cell units (walls.md): plan px extent is [x*quant, (x+bw)*quant).
    Painting per-box with slice assignment is ~10k slice writes, which numpy does
    in milliseconds -- no need for anything cleverer.
    """
    q = walls["quant"]
    k = scale * q / res
    w = int(np.ceil(walls["w"] * scale / res)) + 2
    h = int(np.ceil(walls["h"] * scale / res)) + 2
    g = np.zeros((h, w), dtype=bool)
    b = np.asarray(walls["boxes"], dtype=np.float64).reshape(-1, 4)
    x0 = np.floor(b[:, 0] * k).astype(np.int32)
    y0 = np.floor(b[:, 1] * k).astype(np.int32)
    x1 = np.maximum(np.ceil((b[:, 0] + b[:, 2]) * k).astype(np.int32), x0 + 1)
    y1 = np.maximum(np.ceil((b[:, 1] + b[:, 3]) * k).astype(np.int32), y0 + 1)
    for i in range(b.shape[0]):
        g[y0[i]:y1[i], x0[i]:x1[i]] = True
    return g


def rasterise_filled(walls, scale, res):
    """Footprint polygons -> SOLID bool grid, `res` plan px per grid cell.

    Registering on the wall mask alone does not work: walls are thin (4-5% of
    the page) and a correlation of thin structures has a flat, ambiguous
    landscape -- the first version of this script picked a peak that put the
    shared entrances 330-384 ft apart. The footprint is a solid region, so its
    correlation has one sharp basin. Register on that, then refine on walls.
    """
    from PIL import Image, ImageDraw

    w = int(np.ceil(walls["w"] * scale / res)) + 2
    h = int(np.ceil(walls["h"] * scale / res)) + 2
    img = Image.new("1", (w, h), 0)
    d = ImageDraw.Draw(img)
    k = scale / res
    for part in walls["footprint"]:
        ring = np.asarray(part["outer"], dtype=np.float64).reshape(-1, 2) * k
        if len(ring) >= 3:
            d.polygon([tuple(v) for v in ring], fill=1)
        for hole in part.get("holes", []):
            hr = np.asarray(hole, dtype=np.float64).reshape(-1, 2) * k
            if len(hr) >= 3:
                d.polygon([tuple(v) for v in hr], fill=0)
    return np.array(img, dtype=bool)


def best_shift(ref, mov, sigma):
    """Exhaustive translation search by FFT correlation. Returns (dy, dx, overlap).

    dy/dx are in grid cells: moving cell (p, q) lands on ref cell (p+dy, q+dx).
    The masks are blurred first so the correlation peak is a smooth basin rather
    than a spike -- that is what makes the coarse pass point the fine pass at the
    right place instead of at a one-cell fluke.
    """
    a = gaussian_filter(ref.astype(np.float32), sigma)
    b = gaussian_filter(mov.astype(np.float32), sigma)
    corr = fftconvolve(a, b[::-1, ::-1], mode="full")
    idx = int(np.argmax(corr))
    i, j = np.unravel_index(idx, corr.shape)
    return i - (mov.shape[0] - 1), j - (mov.shape[1] - 1), float(corr[i, j])


def hard_scores(ref, mov, dy, dx):
    """Dice + coverage of the *unblurred* masks at a given integer shift."""
    h, w = ref.shape
    ys0, ys1 = max(0, dy), min(h, dy + mov.shape[0])
    xs0, xs1 = max(0, dx), min(w, dx + mov.shape[1])
    if ys0 >= ys1 or xs0 >= xs1:
        return 0.0, 0.0
    inter = np.count_nonzero(
        ref[ys0:ys1, xs0:xs1] & mov[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
    )
    na, nb = int(ref.sum()), int(mov.sum())
    return 2.0 * inter / (na + nb), inter / max(nb, 1)


def sweep(ref_walls, mov_walls, scales, res, sigma):
    ref = rasterise(ref_walls, 1.0, res)
    out = []
    for s in scales:
        mov = rasterise(mov_walls, s, res)
        dy, dx, _ = best_shift(ref, mov, sigma)
        dice, cov = hard_scores(ref, mov, dy, dx)
        out.append((dice, cov, s, dx * res, dy * res))
    out.sort(reverse=True)
    return out


def sweep_filled(ref_walls, mov_walls, scales, res, sigma):
    """Coarse registration on solid footprints. Returns sorted (dice, cov, s, tx, ty)."""
    ref = rasterise_filled(ref_walls, 1.0, res)
    out = []
    for s_ in scales:
        mov = rasterise_filled(mov_walls, s_, res)
        dy, dx, _ = best_shift(ref, mov, sigma)
        dice, cov = hard_scores(ref, mov, dy, dx)
        out.append((dice, cov, s_, dx * res, dy * res))
    out.sort(reverse=True)
    return out


def refine_on_walls(ref_walls, mov_walls, s0, tx0, ty0, res=2,
                    dscale=0.04, dt=70, nscale=9, step=4):
    """Local search on the WALL masks around a footprint-derived starting point.

    The footprint pins the building; the walls pin the corridors inside it. This
    only ever moves a short distance, so the flat-landscape problem that sinks a
    global wall correlation does not arise.
    """
    ref = rasterise(ref_walls, 1.0, res)
    best = None
    for s_ in np.linspace(s0 - dscale, s0 + dscale, nscale):
        mov = rasterise(mov_walls, s_, res)
        for ty in range(int(ty0 - dt), int(ty0 + dt) + 1, step):
            for tx in range(int(tx0 - dt), int(tx0 + dt) + 1, step):
                dice, cov = hard_scores(ref, mov, int(round(ty / res)), int(round(tx / res)))
                if best is None or dice > best[0]:
                    best = (dice, cov, float(s_), float(tx), float(ty))
    return best


def entrance_fit(floor):
    """Least-squares scale + translation from the entrances shared with main.

    Rotation is pinned to 0 (arch.md 2: it is not identifiable from 2-3 points,
    and a wrong rotation is far more visually destructive than a wrong shift).

    These are the only real point correspondences the data contains. Registering
    the wall or footprint MASKS instead was tried and is worse: the storeys
    genuinely differ in extent -- upper has wings main does not, lower is
    smaller -- so maximising overlap slides one storey inside the other's mass
    rather than lining up the structure they share. Measured: mask registration
    put the shared entrances 220-400 ft apart, and the overlay was visibly wrong.
    """
    a = json.load(open(os.path.join(FLOORS_DIR, "%s.json" % floor)))
    m = json.load(open(os.path.join(FLOORS_DIR, "%s.json" % REF)))
    P, R = [], []
    for key in a["entrances"]:
        if key in m["points"] and key in a["points"]:
            P.append([a["points"][key]["x"], a["points"][key]["y"]])
            R.append([m["points"][key]["x"], m["points"][key]["y"]])
    P, R = np.asarray(P, float), np.asarray(R, float)
    if len(P) < 2:
        return None
    pm, rm = P.mean(0), R.mean(0)
    dp, dr = P - pm, R - rm
    denom = (dp * dp).sum()
    s_ = float((dp * dr).sum() / denom) if denom > 1e-9 else 1.0
    t = rm - s_ * pm
    return s_, float(t[0]), float(t[1]), len(P)


def entrance_residuals(floor, scale, tx, ty):
    """Cross-check: how far does each shared entrance land from main's, in feet."""
    a = json.load(open(os.path.join(FLOORS_DIR, "%s.json" % floor)))
    m = json.load(open(os.path.join(FLOORS_DIR, "%s.json" % REF)))
    px_per_ft = 2.6
    rows = []
    for key in a["entrances"]:
        if key not in m["points"]:
            continue
        p, r = a["points"][key], m["points"][key]
        sx, sy = p["x"] * scale + tx, p["y"] * scale + ty
        d = np.hypot(sx - r["x"], sy - r["y"])
        rows.append((key, d / px_per_ft, sx - r["x"], sy - r["y"]))
    return rows


def footprint_width(walls, scale=1.0):
    b = np.asarray(walls["boxes"], dtype=np.float64).reshape(-1, 4)
    q = walls["quant"]
    lo, hi = (b[:, 0] * q).min(), ((b[:, 0] + b[:, 2]) * q).max()
    loy, hiy = (b[:, 1] * q).min(), ((b[:, 1] + b[:, 3]) * q).max()
    return (hi - lo) * scale, (hiy - loy) * scale


def render(ref_walls, mov_walls, scale, tx, ty, path, res=3):
    from PIL import Image

    ref = rasterise(ref_walls, 1.0, res)
    mov = rasterise(mov_walls, scale, res)
    dy, dx = int(round(ty / res)), int(round(tx / res))
    h = max(ref.shape[0], dy + mov.shape[0]) + max(0, -dy)
    w = max(ref.shape[1], dx + mov.shape[1]) + max(0, -dx)
    oy, ox = max(0, -dy), max(0, -dx)
    img = np.full((h, w, 3), 255, dtype=np.uint8)
    canvas_ref = np.zeros((h, w), dtype=bool)
    canvas_ref[oy:oy + ref.shape[0], ox:ox + ref.shape[1]] = ref
    canvas_mov = np.zeros((h, w), dtype=bool)
    canvas_mov[oy + dy:oy + dy + mov.shape[0], ox + dx:ox + dx + mov.shape[1]] = mov
    img[canvas_ref] = (30, 30, 30)          # main = black
    img[canvas_mov] = (225, 40, 40)         # moving floor = red
    img[canvas_ref & canvas_mov] = (150, 40, 160)  # both = purple
    Image.fromarray(img).save(path)
    return path


def main():
    do_render = "--render" in sys.argv
    ref_walls = load_walls(REF)
    print("ref %s footprint px: %.0f x %.0f" % ((REF,) + footprint_width(ref_walls)))

    result = {
        REF: {"floor": REF, "scale": 1.0, "rotationDeg": 0, "tx": 0, "ty": 0,
              "verified": True}
    }

    for floor in MOVING:
        mw = load_walls(floor)
        print("\n=== %s ===" % floor)
        print("  raw footprint px: %.0f x %.0f" % footprint_width(mw))

        # Stage 1: the entrances -- the only real correspondences in the data.
        fit = entrance_fit(floor)
        if fit is None:
            print("  no shared entrances; leaving at identity")
            result[floor] = {"floor": floor, "scale": 1.0, "rotationDeg": 0,
                             "tx": 0.0, "ty": 0.0, "verified": False}
            continue
        s1, tx1, ty1, npts = fit
        print("  entrance fit (%d pts): s=%.4f t=(%.1f, %.1f)" % (npts, s1, tx1, ty1))

        # Stage 2: nudge onto the corridors, but only a little. A tight window
        # keeps the entrance correspondences in charge -- widen it and the wall
        # Dice score walks off to the same wrong answer a global search finds.
        dice, cov, s, tx, ty = refine_on_walls(ref_walls, mw, s1, tx1, ty1,
                                               dscale=0.02, dt=40, nscale=5, step=4)
        print("  wall refine: s=%.4f t=(%.1f, %.1f) dice=%.4f" % (s, tx, ty, dice))
        print("  CHOSEN scale=%.4f tx=%.1f ty=%.1f  dice=%.4f coverage=%.4f"
              % (s, tx, ty, dice, cov))
        print("  scaled footprint px: %.0f x %.0f" % footprint_width(mw, s))
        for key, ft, ex, ey in entrance_residuals(floor, s, tx, ty):
            print("    entrance %-12s residual %6.1f ft  (dx %+7.1f px, dy %+7.1f px)"
                  % (key, ft, ex, ey))

        if do_render:
            p = os.path.join(OUT_DIR, "align-%s.png" % floor)
            render(ref_walls, mw, s, tx, ty, p)
            print("  overlay -> %s" % p)
            # arch.md's shipped seed, for a side-by-side of the two answers
            seed = {"lower": (1.28, -748, -465), "upper": (1.03, -530, -250)}[floor]
            p2 = os.path.join(OUT_DIR, "align-%s-archseed.png" % floor)
            render(ref_walls, mw, seed[0], seed[1], seed[2], p2)
            print("  arch.md seed overlay -> %s" % p2)

        result[floor] = {"floor": floor, "scale": round(float(s), 4), "rotationDeg": 0,
                         "tx": round(float(tx), 1), "ty": round(float(ty), 1),
                         "verified": False}

    out = os.path.join(FLOORS_DIR, "align3d.json")
    with open(out, "w") as fh:
        json.dump(result, fh, indent=2)
        fh.write("\n")
    print("\nwrote %s" % out)


if __name__ == "__main__":
    main()
