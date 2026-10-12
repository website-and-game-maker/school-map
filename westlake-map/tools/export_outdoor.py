#!/usr/bin/env python3
"""Derive src/data/outdoor.json: the real streets, fields and buildings around
the school, placed in the map's own world frame.

Source: Overture Maps (https://overturemaps.org), which republishes
OpenStreetMap's roads, buildings and land use as GeoParquet on a public S3
bucket. Overture rather than the OSM APIs because S3 range reads need no API
and pull only the row groups that cover the school; the content is OSM's, so
the app credits OpenStreetMap contributors.

The hard part is not the download, it is where to put it. The plan scans have
no coordinates, so the map's world frame (feet from main's page centre, plan
"up" assumed north) has to be registered against the real world:

  - OSM's footprint of the school building (plus the buildings touching it) is
    rasterised in local feet around the school, x east and y south.
  - The union of main's and upper's footprints (walls-*.json, placed with
    align3d.json) is the plan's idea of the same building. Lower is left out on
    purpose: it is partly under the hill, so it reaches past the roof line that
    OSM traces, and including it drags the fit south.
  - Rotation and uniform scale are swept; for each pair the translation comes
    exactly out of one FFT cross-correlation. Score is IoU.

Measured on the 2026-09-23 release: rotation 6.5 deg, scale 0.90, IoU 0.78.
The upper floor's north-west wing, main's north edge and the curved front all
land on OSM's outline, which is what makes the fit believable. Two findings
that fall out of it, recorded here rather than acted on:

  - Plan "up" is 6.5 deg clockwise of true north.
  - The plan is drawn ~11% bigger than the building OSM traces, i.e.
    PX_PER_FOOT would be ~2.9 rather than 2.6 if OSM's outline is right. It is
    the only real-world measurement this project has; directions.ts owns the
    constant and nothing here changes it. The outdoor layer is scaled to the
    plan instead, so the school and its surroundings agree on screen.

Usage:  python3 -m pip install pyarrow shapely numpy pillow
        python3 tools/export_outdoor.py              # fetch, fit, write
        python3 tools/export_outdoor.py --render     # also /tmp/outdoor-fit.png
"""

import json
import math
import os
import sys

import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import shapely
from PIL import Image, ImageDraw
from shapely import affinity
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FLOORS = os.path.join(ROOT, "src", "data", "floors")
OUT = os.path.join(ROOT, "src", "data", "outdoor.json")

RELEASE = "2026-09-23.1"
BUCKET = "overturemaps-us-west-2/release/" + RELEASE

# Westlake High School, near the middle of the main building.
LAT0, LON0 = 30.2760, -97.8135
FT_PER_DEG_LAT = 364000.0
FT_PER_DEG_LON = FT_PER_DEG_LAT * math.cos(math.radians(LAT0))
# What to fetch: about 3500 ft each way, more than the camera can show.
BBOX = (-97.824, 30.267, -97.802, 30.284)
# What to keep, in world feet from the plan's centre.
KEEP = 2600

SITE_ORIGIN = (1583.5, 1224.0)  # units.ts
PX_PER_FOOT = 2.6  # directions.ts


def ll_to_local(lon, lat):
    return ((lon - LON0) * FT_PER_DEG_LON, -(lat - LAT0) * FT_PER_DEG_LAT)


# ---------------------------------------------------------------- download


def fetch(theme, typ):
    s3 = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    d = ds.dataset("%s/theme=%s/type=%s" % (BUCKET, theme, typ), filesystem=s3, format="parquet")
    w, s, e, n = BBOX
    f = (
        (pc.field("bbox", "xmin") < e)
        & (pc.field("bbox", "xmax") > w)
        & (pc.field("bbox", "ymin") < n)
        & (pc.field("bbox", "ymax") > s)
    )
    rows = d.to_table(filter=f).to_pylist()
    for r in rows:
        r["geom"] = shapely.transform(shapely.from_wkb(r["geometry"]), lambda a: np.column_stack(ll_to_local(a[:, 0], a[:, 1])))
        r["name"] = (r.get("names") or {}).get("primary")
    print("  %s/%s: %d" % (theme, typ, len(rows)))
    return rows


# --------------------------------------------------------------------- fit


def plan_footprint(floors):
    align = json.load(open(os.path.join(FLOORS, "align3d.json")))
    parts = []
    for fl in floors:
        p = align[fl]
        assert p["rotationDeg"] == 0
        for fp in json.load(open(os.path.join(FLOORS, "walls-%s.json" % fl)))["footprint"]:
            o = fp["outer"]
            pts = [
                ((p["scale"] * o[i] + p["tx"] - SITE_ORIGIN[0]) / PX_PER_FOOT,
                 (p["scale"] * o[i + 1] + p["ty"] - SITE_ORIGIN[1]) / PX_PER_FOOT)
                for i in range(0, len(o), 2)
            ]
            parts.append(Polygon(pts).buffer(0))
    return unary_union(parts)


def raster(g, n, res, off):
    img = Image.new("L", (n, n), 0)
    dr = ImageDraw.Draw(img)
    for p in getattr(g, "geoms", [g]):
        dr.polygon([((x + off) / res, (y + off) / res) for x, y in p.exterior.coords], fill=1)
        for h in p.interiors:
            dr.polygon([((x + off) / res, (y + off) / res) for x, y in h.coords], fill=0)
    return np.asarray(img, dtype=np.float32)


def search(plan, osm, res, thetas, scales):
    n = int(2600 / res)
    off = 1300
    target = raster(osm, n, res, off)
    ft = np.conj(np.fft.rfft2(target))
    area = target.sum()
    best = None
    for th in thetas:
        for s in scales:
            g = affinity.scale(affinity.rotate(plan, th, origin=(0, 0)), s, s, origin=(0, 0))
            m = raster(g, n, res, off)
            c = np.fft.irfft2(np.fft.rfft2(m) * ft, s=m.shape)
            i = np.unravel_index(np.argmax(c), c.shape)
            iou = c[i] / (area + m.sum() - c[i])
            dy, dx = [(v if v < n // 2 else v - n) * res for v in i]
            if best is None or iou > best[0]:
                best = (float(iou), float(th), float(s), float(-dx), float(-dy))
    return best


def fit(buildings):
    school = max((b for b in buildings if b["name"] == "Westlake High School"), key=lambda b: b["geom"].area)["geom"]
    osm = unary_union([b["geom"] for b in buildings if b["geom"].distance(school) < 40 and b["geom"].area > 2000])
    plan = plan_footprint(["main", "upper"])
    coarse = search(plan, osm, 6, np.arange(-45, 45.1, 3), np.arange(0.7, 1.31, 0.05))
    _, th0, s0, _, _ = coarse
    fine = search(plan, osm, 3, np.arange(th0 - 3, th0 + 3.01, 0.5), np.arange(s0 - 0.06, s0 + 0.061, 0.01))
    iou, th, s, tx, ty = fine
    print("  fit: rotation %.1f deg, scale %.2f, offset (%.0f, %.0f) ft, IoU %.3f" % (th, s, tx, ty, iou))
    return {"rotationDeg": round(th, 2), "scale": round(s, 3), "offsetFt": [round(tx, 1), round(ty, 1)], "iou": round(iou, 3)}, plan, osm


def local_to_world(geo):
    """Inverse of the fit: OSM local feet -> the map's world feet."""
    t = math.radians(-geo["rotationDeg"])
    c, s_ = math.cos(t), math.sin(t)
    k = geo["scale"]
    tx, ty = geo["offsetFt"]

    def f(a):
        x = (a[:, 0] - tx) / k
        y = (a[:, 1] - ty) / k
        return np.column_stack((c * x - s_ * y, s_ * x + c * y))

    return f


# ------------------------------------------------------------------ export

AREA_KIND = {
    ("education", "school"): "school",
    ("education", "schoolyard"): "school",
    ("recreation", "pitch"): "pitch",
    ("recreation", "track"): "track",
    ("recreation", "playground"): "grass",
    ("recreation", "recreation_ground"): "grass",
    ("managed", "grass"): "grass",
    ("park", "park"): "grass",
    ("horticulture", "garden"): "grass",
    ("protected", "nature_reserve"): "wood",
    ("forest", "wood"): "wood",
    ("forest", "forest"): "wood",
    ("grass", "grass"): "grass",
    ("transit", "parking"): "parking",
    ("reservoir", "basin"): "water",
    ("river", "river"): "water",
    ("human_made", "swimming_pool"): "water",
}
# Drawn bottom to top.
AREA_ORDER = ["school", "wood", "grass", "parking", "track", "pitch", "water"]

ROAD_KIND = {
    "motorway": "major", "trunk": "major", "primary": "major", "secondary": "major",
    "tertiary": "minor", "residential": "minor", "unclassified": "minor", "living_street": "minor",
    "service": "service", "unknown": "service",
    "footway": "path", "path": "path", "cycleway": "path", "pedestrian": "path", "steps": "path",
}


def flat(coords):
    out = []
    for x, y in coords:
        out += [int(round(float(x))), int(round(float(y)))]
    return out


def polys(g):
    if g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    return [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]


def lines(g):
    if g.is_empty:
        return []
    if g.geom_type == "LineString":
        return [g]
    return [p for p in getattr(g, "geoms", []) if p.geom_type == "LineString"]


def main():
    print("fetching %s" % RELEASE)
    buildings = fetch("buildings", "building")
    land_use = fetch("base", "land_use")
    land = fetch("base", "land")
    water = fetch("base", "water")
    infra = fetch("base", "infrastructure")
    segments = fetch("transportation", "segment")

    geo, plan, osm = fit(buildings)
    to_world = local_to_world(geo)
    keep = box(-KEEP, -KEEP, KEEP, KEEP)

    def world(g, tol):
        g = shapely.transform(g, to_world).intersection(keep)
        return g.simplify(tol, preserve_topology=True) if tol else g

    areas = []
    labels = []
    for r in land_use + land + water + infra:
        kind = AREA_KIND.get((r.get("subtype"), r.get("class")))
        if not kind or r["geom"].geom_type not in ("Polygon", "MultiPolygon"):
            continue
        # Overture's land_use includes a few continent-sized protected areas
        # whose bbox happens to cover Austin.
        if r["geom"].area > 4e7:
            continue
        for p in polys(world(r["geom"], 1.5)):
            if p.area < 200:
                continue
            areas.append({"k": kind, "rings": [flat(p.exterior.coords[:-1])] + [flat(h.coords[:-1]) for h in p.interiors]})
        if r["name"] and kind in ("pitch", "track", "school", "grass") and r["geom"].area > 3000:
            c = shapely.transform(r["geom"], to_world).representative_point()
            # A name that would sit on the building itself is the plan's job.
            # The school's own grounds need no name: the school is the map.
            if r["name"] == "Westlake High School":
                continue
            if abs(c.x) < KEEP and abs(c.y) < KEEP and not plan.contains(c):
                labels.append({"text": r["name"], "x": int(round(c.x)), "z": int(round(c.y)), "k": "area", "area": r["geom"].area})
    areas.sort(key=lambda a: AREA_ORDER.index(a["k"]))

    blds = []
    for r in buildings:
        for p in polys(world(r["geom"], 1.0)):
            if p.area > 60:
                blds.append(flat(p.exterior.coords[:-1]))

    roads = []
    named = {}
    for r in segments:
        kind = ROAD_KIND.get(r.get("class"))
        if r.get("subtype") != "road" or not kind:
            continue
        for ln in lines(world(r["geom"], 1.0)):
            if ln.length < 4:
                continue
            roads.append({"k": kind, "pts": flat(ln.coords)})
            if r["name"] and kind in ("major", "minor"):
                named.setdefault(r["name"], []).append(ln)
    order = ["path", "service", "minor", "major"]
    roads.sort(key=lambda r: order.index(r["k"]))

    # One label per street, on its longest piece, unless it is far off-screen.
    for name, ls in named.items():
        ln = max(ls, key=lambda l: l.length)
        if ln.length < 250:
            continue
        mid = ln.interpolate(0.5, normalized=True)
        labels.append({"text": name, "x": int(round(mid.x)), "z": int(round(mid.y)), "k": "road", "area": ln.length * 40})
    # Biggest first, so a collision drops the smaller name.
    labels.sort(key=lambda l: -l["area"])
    for l in labels:
        del l["area"]
    # The same field shows up as several overlapping polygons; keep one name.
    seen = set()
    labels = [l for l in labels if not (l["text"] in seen or seen.add(l["text"]))]

    out = {
        "source": "© OpenStreetMap contributors, via Overture Maps " + RELEASE,
        "geo": dict(
            geo,
            origin=[LAT0, LON0],
            verified=False,
            note="world = R(-rotationDeg) * (localFt - offsetFt) / scale; localFt is x east, y south of origin",
        ),
        "areas": areas,
        "buildings": blds,
        "roads": roads,
        "labels": labels,
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print("wrote %s: %d areas, %d buildings, %d roads, %d labels, %.0f KB"
          % (os.path.relpath(OUT, ROOT), len(areas), len(blds), len(roads), len(labels), os.path.getsize(OUT) / 1024))

    if "--render" in sys.argv:
        img = Image.new("RGB", (1400, 1400), "white")
        dr = ImageDraw.Draw(img)
        f = lambda x, y: ((x + 1000) * 0.7, (y + 1000) * 0.7)
        for p in polys(shapely.transform(osm, to_world)):
            dr.polygon([f(*c) for c in p.exterior.coords], fill="#ddd", outline="black")
        for p in polys(plan):
            dr.line([f(*c) for c in p.exterior.coords], fill="red", width=2)
        img.save("/tmp/outdoor-fit.png")
        print("wrote /tmp/outdoor-fit.png")


if __name__ == "__main__":
    main()
