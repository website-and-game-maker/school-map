#!/usr/bin/env python3
"""Tighten two storey footprints that included ground that is not that floor.

The footprint is the floor plate the 3D view draws, so a footprint that runs
outside the building draws floor over car park. Once all three storeys are
shown stacked, two such errors stood out:

* Lower. Its footprint took in the outdoor pocket south of the 161-175 rows
  (where the sheet prints "South Complex / Tennis & Softball / Learning
  Center"), because the room reader classed that pocket as a corridor. The
  footprint is rebuilt here as the closed union of the floor's rooms,
  corridors and walls, with those two outdoor "corridors" removed from
  rooms-lower.json as well, so the plate stops drawing them as hallway.

* Main. The main sheet draws the Black Box Theater (a Lower-level space) as
  context below Entrance D, and the footprint took it in. It is cut off south
  of Entrance D's corridor.

Run after export_walls.py / export_rooms.py, which would otherwise put the
old outlines back. Idempotent.

Usage:  python3 tools/fix_footprints.py
"""

import json
import os

import numpy as np
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FLOORS = os.path.join(ROOT, "src", "data", "floors")

# Lower's outdoor pockets, by their bounding box in plan px (x0, y0, x1, y1):
# both lie wholly south of the 161-175 classroom rows.
LOWER_OUTDOOR = [(1447, 1662, 2283, 2088), (1725, 1893, 1881, 2065)]
# Outdoor landmarks that are drawn on the lower sheet but are not lower floor.
LOWER_OUTSIDE_ROOMS = {"Practice Field 3"}
# Main: everything south of this line and east of this x is the Black Box
# Theater drawn as Lower-level context.
MAIN_CUT = box(2000, 1840, 2700, 2400)

CLOSE_PX = 14
MIN_HOLE_PX2 = 3000


def load(name):
    with open(os.path.join(FLOORS, name)) as fh:
        return json.load(fh)


def save(name, data):
    with open(os.path.join(FLOORS, name), "w") as fh:
        json.dump(data, fh, separators=(",", ":"))


def poly(flat):
    return Polygon(np.asarray(flat, float).reshape(-1, 2)).buffer(0)


def bbox_of(flat):
    a = np.asarray(flat, float).reshape(-1, 2)
    return a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max()


def is_outdoor(flat):
    x0, y0, x1, y1 = bbox_of(flat)
    return any(abs(x0 - b[0]) < 3 and abs(y0 - b[1]) < 3 and abs(x1 - b[2]) < 3 and abs(y1 - b[3]) < 3
               for b in LOWER_OUTDOOR)


def to_parts(geom):
    """Shapely (Multi)Polygon -> walls.json footprint parts."""
    out = []
    for g in getattr(geom, "geoms", [geom]):
        if g.is_empty or g.area < 5000:
            continue
        g = g.simplify(1.5)
        flat = lambda ring: [round(v, 1) for xy in list(ring.coords)[:-1] for v in xy]
        holes = [flat(h) for h in g.interiors if Polygon(h).area >= MIN_HOLE_PX2]
        out.append({"outer": flat(g.exterior), "holes": holes})
    return out


def fix_lower():
    rooms = load("rooms-lower.json")
    walls = load("walls-lower.json")
    rooms["corridors"] = [c for c in rooms["corridors"] if not is_outdoor(c["poly"])]
    parts = [poly(r["poly"]) for r in rooms["rooms"]
             if len(r["poly"]) >= 6 and r["label"] not in LOWER_OUTSIDE_ROOMS]
    parts += [poly(c["poly"]) for c in rooms["corridors"] if len(c["poly"]) >= 6]
    parts += [poly(o) for o in walls.get("outlines", []) if len(o) >= 6]
    solid = unary_union(parts).buffer(CLOSE_PX).buffer(-CLOSE_PX)
    walls["footprint"] = to_parts(solid)
    save("rooms-lower.json", rooms)
    save("walls-lower.json", walls)
    print("lower: footprint %.0f px2 in %d part(s)" % (solid.area, len(walls["footprint"])))


def fix_main():
    walls = load("walls-main.json")
    geoms = []
    for p in walls["footprint"]:
        g = poly(p["outer"])
        for h in p.get("holes", []):
            g = g.difference(poly(h))
        geoms.append(g)
    solid = unary_union(geoms).difference(MAIN_CUT)
    walls["footprint"] = to_parts(solid)
    save("walls-main.json", walls)
    print("main: footprint %.0f px2" % solid.area)


if __name__ == "__main__":
    fix_lower()
    fix_main()
