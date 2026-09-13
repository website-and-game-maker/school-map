"""Export room and corridor OUTLINES, so the app can draw the school itself.

Until now the map was the scan: the plan page was shown directly in 2D and used
as the floor texture in 3D. That put the school's original floor plans on the
open web at full resolution for anyone who opened devtools, which is not
something a student project should be doing.

So the map gets rebuilt from shapes instead. The walls were already vectorised
(tools/export_walls.py); what was missing was the *spaces* — the rooms and the
corridors between them. Those are the negative space of the wall mask: flood the
storey, and every pocket the walls enclose is a room, while the one big
connected pocket that threads through all of them is the circulation.

Each pocket is matched to the traced label that falls inside it, so a room comes
out knowing it is "245" and the corridor comes out knowing it is not a room.
Nothing here reads pixels at runtime; the output is a few hundred polygons.

Usage:  python3 tools/export_rooms.py [floor ...]
"""

import json
import os
import sys

import numpy as np
from scipy import ndimage as ndi

import export_walls as ew

# A pocket smaller than this is a wall gap or a scanning artefact, not a space.
# At 2.6 px per foot this is about 90 sq ft, so a single office still counts;
# 2500 px was tried first and silently dropped every small room on the plan.
MIN_ROOM_PX = 600
# Outlines are traced at 1/2 scale and simplified; rooms are boxy, so this can
# be looser than the footprint tolerance without anyone noticing.
DOWN = 2
TOL = 2.5
# A label has to land this close to a pocket to claim it. Traced positions sit
# on the room's number, which is inside the room, so this only has to absorb
# the label sitting on top of a wall.
CLAIM_PX = 26
# A pocket holding more than one room number, or bigger than any single room in
# the building, is not a room -- it is rooms that leaked into each other or into
# the corridor through a gap in the scan. Those get drawn as plain floor instead
# of as one enormous room, which is what made the map look glitchy. The gym is
# about 10,000 sq ft, so the cap sits above it.
MERGED_AREA_PX = 120000


def labelled_points(floor):
    """Every traced point that names a space, with its kind."""
    path = os.path.join(ew.OUT_DIR, f'{floor}.json')
    d = json.load(open(path))
    out = []
    for pid, p in d.get('points', {}).items():
        if p.get('kind') in ('room', 'landmark'):
            out.append({
                'id': pid,
                'label': p.get('label') or pid,
                'kind': p['kind'],
                'x': float(p['x']),
                'y': float(p['y']),
            })
    return out


def outline(mask, offset=(0, 0)):
    """Largest boundary loop of a full-resolution mask, simplified, in plan px.

    Tracing runs on a half-scale copy purely for speed and to take the stair-step
    out of the scan; the labelling that decided this mask ran at full resolution.
    """
    small = ew.quantise(mask, DOWN)
    loops = ew.trace_loops(small)
    if not loops:
        return []
    best = max(loops, key=lambda l: abs(ew.signed_area(l)))
    pts = [((x + offset[0] / DOWN) * DOWN, (y + offset[1] / DOWN) * DOWN) for x, y in best]
    pts = ew.dp_simplify(pts + [pts[0]], TOL)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    return [int(round(v)) for xy in pts for v in xy]


def build(floor, verbose=True):
    """Rooms are pockets of the PRE-CARVE free space, not of the wall mask.

    This is the one thing that has to be got right. The vectorised walls in
    walls-*.json look like walls but are not watertight -- the line opening and
    the blob filter that make them clean also leave gaps -- so flooding their
    negative space merges every room into one blob: measured on Main, the
    largest pocket held 94% of the free area and swallowed 100 of 113 labels.

    The raw ink is watertight, because these plans draw every door CLOSED. That
    is a nuisance for routing (mask4.py has to carve the doors open again) but it
    is exactly what is wanted here: before carving, each room is a sealed pocket.
    """
    grey, ink, page_fp = ew.ink_and_footprint(os.path.join(ew.ASSETS, f'{floor}-level.jpg'))
    ink_in_page = ink & page_fp
    lines, per = ew.long_lines(ink_in_page)
    hatch = ew.hatch_mask(ink_in_page, per)
    pts = ew.room_points(floor)
    st = ew.storey_mask(ink_in_page, lines, pts, grey.shape) & ~hatch

    # Label at FULL resolution. Quantising first was tried and silently merges
    # rooms: these partitions are 2 px of ink, and a half-scale cell straddling
    # one comes out empty, opening a hole between two rooms.
    free = (~ink) & page_fp & st
    lab, n = ndi.label(free, structure=np.ones((3, 3)))
    sizes = ndi.sum(free, lab, range(1, n + 1)).astype(int)
    objs = ndi.find_objects(lab)

    named = labelled_points(floor)
    claimed = {}
    h, w = lab.shape
    for p in named:
        # A traced position sits on the room's printed number, which is ink, so
        # the pixel under it usually belongs to no pocket at all. Take whichever
        # pocket dominates the window around it, exactly as export_nav.py does.
        cx, cy = int(p['x']), int(p['y'])
        y0, y1 = max(0, cy - CLAIM_PX), min(h, cy + CLAIM_PX)
        x0, x1 = max(0, cx - CLAIM_PX), min(w, cx + CLAIM_PX)
        win = lab[y0:y1, x0:x1]
        vals, counts = np.unique(win[win > 0], return_counts=True)
        if not len(vals):
            continue
        comp = int(vals[np.argmax(counts)])
        if sizes[comp - 1] >= MIN_ROOM_PX:
            claimed.setdefault(comp, []).append(p)

    rooms = []
    merged = []
    for comp, owners in claimed.items():
        sl = objs[comp - 1]
        poly = outline(lab[sl] == comp, offset=(sl[1].start, sl[0].start))
        if len(poly) < 6:
            continue
        area = int(sizes[comp - 1])
        room_owners = [q for q in owners if q['kind'] == 'room']
        if len(room_owners) > 1 or area > MERGED_AREA_PX:
            merged.append({'area': area, 'poly': poly})
            continue
        owner = min(owners, key=lambda q: 0 if q['kind'] == 'room' else 1)
        rooms.append({
            'id': owner['id'],
            'label': owner['label'],
            'kind': owner['kind'],
            'x': int(round(owner['x'])),
            'y': int(round(owner['y'])),
            'area': area,
            'poly': poly,
        })

    # Circulation: the big pockets nobody claimed. On these plans the corridors
    # are chopped into runs by every door frame, so there are several.
    order = np.argsort(sizes)[::-1]
    corridors = list(merged)
    for i in order:
        comp = int(i + 1)
        if comp in claimed or sizes[i] < MIN_ROOM_PX * 2:
            continue
        sl = objs[comp - 1]
        poly = outline(lab[sl] == comp, offset=(sl[1].start, sl[0].start))
        if len(poly) >= 6:
            corridors.append({'area': int(sizes[i]), 'poly': poly})
        if len(corridors) >= 60:
            break

    if verbose:
        ew.log(f'  {floor}: {n} pockets, {len(rooms)} rooms drawn, '
               f'{len(merged)} merged blobs demoted to floor, '
               f'{len(corridors)} floor regions, {len(named)} labels')
        missing = [p['label'] for p in named if not any(r['id'] == p['id'] for r in rooms)]
        if missing:
            ew.log(f'    unmatched ({len(missing)}): {missing[:12]}')

    d = json.load(open(os.path.join(ew.OUT_DIR, f'{floor}.json')))
    return {
        'floor': floor,
        'w': d['image']['w'],
        'h': d['image']['h'],
        'rooms': rooms,
        'corridors': corridors,
        # Every traced name, drawn as text regardless of whether its pocket
        # survived as a room. The number is the thing people navigate by.
        'labels': [{'label': p['label'], 'kind': p['kind'],
                    'x': int(round(p['x'])), 'y': int(round(p['y']))}
                   for p in named],
    }


if __name__ == '__main__':
    for floor in (sys.argv[1:] or list(ew.FLOORS)):
        payload = build(floor)
        path = os.path.join(ew.OUT_DIR, f'rooms-{floor}.json')
        with open(path, 'w') as fh:
            json.dump(payload, fh, separators=(',', ':'))
        ew.log(f'  {floor}: wrote {path}  {os.path.getsize(path)/1024:.1f} KB')
