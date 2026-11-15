#!/usr/bin/env python3
"""Put named places on the floor they are actually on.

Every sheet of the plan booklet labels the other levels' spaces as context,
with the level in brackets: the Lower sheet prints "COUNSELING (Main Level)",
"BAND HALL (Upper Level)" and so on over the whole building, and the Main
sheet prints "CAFETERIA (Lower Level)". The landmark reader took each name as
being on the sheet it was printed on, so Lower listed twelve Main and Upper
places, Main listed four Lower and Upper ones, and a search for "Band Hall"
routed you to the basement.

This moves each one to its real floor. A place's position is carried across
through align3d.json (sheet -> site -> other sheet), which lands it where the
target sheet draws that space (checked by eye: the Fieldhouse Gym lands on
Upper's 400 courts, the Band Hall on 438). Where the real floor already has
the place, the misplaced copy is just dropped. Idempotent.

Usage:  python3 tools/fix_landmark_floors.py
"""

import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FLOORS = os.path.join(ROOT, "src", "data", "floors")

# name: (printed on, really on). None = the real floor already has it.
MOVES = {
    # The Lower sheet's context labels.
    "Counseling": ("lower", "main"),
    "Administration": ("lower", "main"),
    "Commons": ("lower", "main"),
    "Visual Arts": ("lower", "main"),
    "Chap Court": ("lower", None),
    "Practice Gym": ("lower", None),
    # "RESEARCH CENTER (Main Level)" is the Library's footprint, already on Main.
    "Research Center": ("lower", None),
    "Fieldhouse Gym": ("lower", "upper"),
    "Varsity Athletics": ("lower", "upper"),
    "Choir Room": ("lower", "upper"),
    "Performing Arts Center": ("lower", "upper"),
    "Band Hall": ("lower", "upper"),
}
# The Main sheet's: Lower already has these as rooms; Fieldhouse comes from
# Lower's label above, which sits on Upper's courts.
MAIN_DROP = ["Cafeteria", "Sub-Varsity Gym", "Black Box Theater", "Fieldhouse Gym"]
# Lower's own copies of those become landmarks, so they get a pin and a
# category like any named place.
LOWER_PROMOTE = ["Cafeteria", "Sub-Varsity Gym", "Black Box Theater"]


def load(name):
    with open(os.path.join(FLOORS, name)) as fh:
        return json.load(fh)


def save_floor(f, data):
    with open(os.path.join(FLOORS, "%s.json" % f), "w") as fh:
        fh.write(json.dumps(data, indent=1))


def save_compact(name, data):
    with open(os.path.join(FLOORS, name), "w") as fh:
        json.dump(data, fh, separators=(",", ":"))


ALIGN = load("align3d.json")


def to_site(f, x, y):
    p = ALIGN[f]
    t = math.radians(p["rotationDeg"])
    c, s = math.cos(t), math.sin(t)
    return p["scale"] * (c * x - s * y) + p["tx"], p["scale"] * (s * x + c * y) + p["ty"]


def from_site(f, sx, sy):
    p = ALIGN[f]
    t = math.radians(-p["rotationDeg"])
    c, s = math.cos(t), math.sin(t)
    dx, dy = (sx - p["tx"]) / p["scale"], (sy - p["ty"]) / p["scale"]
    return c * dx - s * dy, s * dx + c * dy


def main():
    floors = {f: load("%s.json" % f) for f in ("lower", "main", "upper")}
    rooms = {f: load("rooms-%s.json" % f) for f in floors}

    def drop(f, name):
        p = floors[f]["points"].pop(name, None)
        r = rooms[f]
        r["labels"] = [l for l in r["labels"] if not (l["kind"] == "landmark" and l["label"] == name)]
        r["rooms"] = [x for x in r["rooms"] if not (x["kind"] == "landmark" and x["label"] == name)]
        return p

    def add(f, name, x, y):
        if name in floors[f]["points"]:
            return
        floors[f]["points"][name] = {"x": round(x, 1), "y": round(y, 1), "kind": "landmark", "label": name}
        rooms[f]["labels"].append({"label": name, "kind": "landmark", "x": round(x), "y": round(y)})

    for name, (src, dst) in MOVES.items():
        p = drop(src, name)
        if p and dst:
            add(dst, name, *from_site(dst, *to_site(src, p["x"], p["y"])))
            print("%-22s %s -> %s" % (name, src, dst))
        elif p:
            print("%-22s dropped from %s (already on its floor)" % (name, src))

    for name in MAIN_DROP:
        if drop("main", name):
            print("%-22s dropped from main" % name)

    for name in LOWER_PROMOTE:
        p = floors["lower"]["points"].get(name)
        if p and p.get("kind") == "room":
            p["kind"] = "landmark"
            print("%-22s lower room -> landmark" % name)

    for f in floors:
        save_floor(f, floors[f])
        save_compact("rooms-%s.json" % f, rooms[f])


if __name__ == "__main__":
    main()
