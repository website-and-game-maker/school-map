#!/usr/bin/env python3
"""Fit align3d.json: where Lower and Upper sit over Main.

Why this works where the earlier attempts did not (see placement.ts and
seed_align.py for those): every sheet of the plan booklet draws more than its
own floor. The Lower sheet draws the outline of the whole building, labelling
the Main and Upper parts; the Main sheet hatches the Upper-level gym and band
hall and outlines the Lower-level cafeteria, sub-varsity gym and Black Box;
the Upper sheet outlines Main's middle. So the sheets share real shapes, the
same physical walls drawn on every page, and those are what a floor stacked
on another must line up with. seed_align.py registered only each floor's own
extracted walls, which genuinely differ in extent, so it slid one storey
inside another.

Method: take each page's ink, drop text and the page furniture (title, logo,
compass, fold lines) by keeping only strokes at least 60 px long, blur, and
fit a similarity (scale, rotation, translation) for Lower and Upper together
by maximising normalised cross-correlation of Lower-vs-Main, Upper-vs-Main
and Upper-vs-Lower at once, coarse to fine (blur sigma 3, 2, 1.2 at 1/4
scale). The joint term matters: Upper fitted to Main alone and to Lower alone
agree on scale (1.10-1.11) but not exactly on position, and fitting all three
pairs at once settles it.

Result (2026-11-13): Lower 1.423x, 0.0 deg; Upper 1.103x, -0.55 deg. The old
Upper scale (1.031) was 7% small; Lower moved ~50 px so its gym, cafeteria
and Black Box land on the outlines Main draws for them.

Needs private-source/ (python3 tools/plans.py <MAPWestlake.pdf>).
Usage:  python3 tools/register_floors.py [--write]
"""

import json
import os
import sys

import numpy as np
from scipy import ndimage as ndi
from scipy.optimize import minimize

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plans  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALIGN = os.path.join(ROOT, "src", "data", "floors", "align3d.json")
D = 4  # work at 1/4 scale
MIN_STROKE_PX = 60

# Starting point: the previous placements.
START = {"lower": (1.40, 0.0, -912.0, -608.0), "upper": (1.0314, 0.0, -577.0, -265.0)}


def structure(floor):
    """Long strokes only: walls and outlines, not text or symbols."""
    from PIL import Image

    a = np.asarray(Image.open(plans.page_path(floor)).convert("L"), np.float32) / 255
    ink = a < 0.55
    lab, n = ndi.label(ink)
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndi.find_objects(lab)):
        if max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start) >= MIN_STROKE_PX:
            keep[i + 1] = True
    k = keep[lab]
    H, W = k.shape
    for c in np.where(k.mean(axis=0) > 0.25)[0]:  # fold lines
        k[:, max(0, c - 6):c + 7] = False
    for r in np.where(k.mean(axis=1) > 0.25)[0]:
        k[max(0, r - 6):r + 7, :] = False
    k[: int(0.16 * H), :] = False  # title
    k[: int(0.36 * H), int(0.70 * W):] = False  # logo, compass
    k[:, int(0.93 * W):] = False
    return k


def shrink(k, sig):
    h, w = k.shape
    s = k[: h // D * D, : w // D * D].reshape(h // D, D, w // D, D).mean(axis=(1, 3)).astype(np.float32)
    return ndi.gaussian_filter(s, sig)


def warp(img, shape, s, rdeg, tx, ty):
    """Sample a floor's page into main's frame: site = s R p + t (full-res px)."""
    t = np.deg2rad(rdeg)
    c, sn = np.cos(t), np.sin(t)
    A = np.array([[c, sn], [-sn, c]]) / s
    Ayx = np.array([[A[1, 1], A[1, 0]], [A[0, 1], A[0, 0]]])
    return ndi.affine_transform(img, Ayx, offset=-Ayx @ np.array([ty / D, tx / D]), output_shape=shape, order=1)


def ncc(a, b):
    return float((a * b).sum() / np.sqrt((a * a).sum() * (b * b).sum()))


def fit():
    raw = {f: structure(f) for f in ("lower", "main", "upper")}
    x = np.array(START["lower"] + START["upper"], float)
    for sig in (3, 2, 1.2):
        main, lo, up = (shrink(raw[f], sig) for f in ("main", "lower", "upper"))
        P = 150  # margin, so Lower's wider sheet is not clipped
        big = np.zeros((main.shape[0] + 2 * P, main.shape[1] + 2 * P), np.float32)
        big[P:-P, P:-P] = main

        def w(img, p):
            s, r, tx, ty = p
            return warp(img, big.shape, s, r, tx + P * D, ty + P * D)

        def cost(v):
            L, U = w(lo, v[:4]), w(up, v[4:])
            return -(ncc(L, big) + ncc(U, big) + ncc(U, L))

        steps = np.array([0.02, 1, 25, 25] * 2)
        simplex = [x] + [x + np.eye(8)[i] * steps[i] for i in range(8)]
        res = minimize(cost, x, method="Nelder-Mead",
                       options=dict(initial_simplex=simplex, xatol=0.05, fatol=1e-6, maxiter=2500))
        x = res.x
        print("sigma %.1f  score %.4f  lower %s  upper %s" % (sig, -res.fun, np.round(x[:4], 3), np.round(x[4:], 3)))
    return x


def write(x):
    with open(ALIGN) as fh:
        data = json.load(fh)
    for f, v in (("lower", x[:4]), ("upper", x[4:])):
        data[f].update(scale=round(float(v[0]), 4), rotationDeg=round(float(v[1]), 3),
                       tx=round(float(v[2]), 1), ty=round(float(v[3]), 1), verified=False)
    with open(ALIGN, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    print("wrote", ALIGN)


if __name__ == "__main__":
    x = fit()
    if "--write" in sys.argv:
        write(x)
