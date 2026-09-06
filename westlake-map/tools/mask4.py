"""Walkable-space extraction with door carving.

The plans draw doors closed: at full resolution not one classroom's interior
connects to the corridor, which is why routing had to fall back on straight
lines. But the plans *do* draw a door as a notch in the wall, so the wall is
measurably thinnest exactly where the door is. Carving each room through its
thinnest wall therefore lands on (or beside) the real doorway.
"""
import numpy as np, json, base64, sys
from PIL import Image
from scipy import ndimage as ndi

PAGES = {'lower': 'page1.png', 'main': 'page0.png', 'upper': 'page2.png'}
CELL = 6
DARK = 170
SPECK = 6
FOOTPRINT_DILATE = 14
MIN_ROOM_PX = 400        # smaller free blobs are furniture gaps, not rooms
MAX_WALL_PX = 16         # don't carve through anything thicker than this
CARVE_RADIUS = 5         # ~11px opening: a realistic doorway width
PASSES = 14

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

def carve_doors(free, verbose=False):
    """Open each enclosed room onto the circulation network. Returns the opened
    free-space mask plus the carve points, which are our best guess at doors."""
    h, w = free.shape
    doors = []
    for _ in range(PASSES):
        lab, n = ndi.label(free, structure=np.ones((3, 3)))
        if n <= 1:
            break
        sizes = ndi.sum(free, lab, range(1, n + 1))
        public = int(np.argmax(sizes)) + 1
        targets = [i + 1 for i, s in enumerate(sizes) if s >= MIN_ROOM_PX and i + 1 != public]
        if not targets:
            break
        dt, inds = ndi.distance_transform_edt(lab != public, return_indices=True)
        spots = ndi.minimum_position(dt, labels=lab, index=targets)
        carved = 0
        for (y, x) in spots:
            y, x = int(y), int(x)
            if dt[y, x] > MAX_WALL_PX:
                continue
            # walk downhill to the public component, opening as we go
            cy, cx = y, x
            for _step in range(int(dt[y, x]) + 4):
                yy0, yy1 = max(0, cy - CARVE_RADIUS), min(h, cy + CARVE_RADIUS + 1)
                xx0, xx1 = max(0, cx - CARVE_RADIUS), min(w, cx + CARVE_RADIUS + 1)
                free[yy0:yy1, xx0:xx1] = True
                if dt[cy, cx] <= 1:
                    break
                cy, cx = int(inds[0, cy, cx]), int(inds[1, cy, cx])
            doors.append((x, y))
            carved += 1
        if verbose:
            print(f'   carved {carved} openings')
        if carved == 0:
            break
    return free, doors

def build(floor, verbose=False):
    a, ink, fp = ink_and_footprint(PAGES[floor])
    free = (~ink) & fp
    # remember the circulation network *before* carving: that's what tells the
    # router which open space is hallway and which is the inside of a room
    lab, n = ndi.label(free, structure=np.ones((3, 3)))
    sizes = ndi.sum(free, lab, range(1, n + 1))
    public_px = lab == int(np.argmax(sizes)) + 1
    free, doors = carve_doors(free.copy(), verbose)
    return a, free, public_px, doors

if __name__ == '__main__':
    for floor in (sys.argv[1:] or ['main', 'lower', 'upper']):
        a, free, public_px, doors = build(floor, verbose=True)
        lab, n = ndi.label(free, structure=np.ones((3, 3)))
        sizes = ndi.sum(free, lab, range(1, n + 1))
        main = int(np.argmax(sizes)) + 1
        d = json.load(open(f'westlake-map/src/data/floors/{floor}.json'))
        rooms = [p for p in d['points'].values() if p['kind'] == 'room']
        hit = 0
        for p in rooms:
            x, y = int(p['x']), int(p['y'])
            if (lab[max(0, y-12):y+12, max(0, x-12):x+12] == main).any():
                hit += 1
        print(f'{floor}: doors carved {len(doors)}, rooms reachable {hit}/{len(rooms)} '
              f'({100*hit/len(rooms):.0f}%)')
