"""Export the navigation data the app routes over.

Per floor, four bit-planes on a 6px grid:
  walk  - standable floor (after doors are carved open)
  pub   - part of the circulation network rather than the inside of a room,
          so the router can prefer hallways and only enter a room to arrive
  east  - a step to the cell on the right is legal (no ink between centres)
  south - likewise, downwards
Diagonal steps are derived from those two in the app.
"""
import numpy as np, json, base64, sys
from scipy import ndimage as ndi
import mask4

CELL = 6

def planes(floor):
    a, free, public_px, doors = mask4.build(floor)
    # `public_px` from mask4 is just the largest pre-carve free blob, which on
    # these plans is whichever big open room happens to win — not the hallways.
    # Corridors get chopped into many components by door frames, so identify
    # rooms instead: any pre-carve pocket holding a traced room label is a room,
    # and everything else (hallways, lobbies, stairwells) is circulation.
    pts = json.load(open(f'westlake-map/src/data/floors/{floor}.json'))['points']
    a2, ink, fp = mask4.ink_and_footprint(mask4.PAGES[floor])
    precarve = (~ink) & fp
    lab, n = ndi.label(precarve, structure=np.ones((3, 3)))
    room_labels = set()
    for pid, pp in pts.items():
        if pp['kind'] != 'room':
            continue
        x, y = int(pp['x']), int(pp['y'])
        win = lab[max(0, y - 10):y + 10, max(0, x - 10):x + 10]
        vals, counts = np.unique(win[win > 0], return_counts=True)
        if len(vals):
            room_labels.add(int(vals[np.argmax(counts)]))
    public_px = precarve & ~np.isin(lab, list(room_labels))
    h, w = a.shape
    rows, cols = -(-h // CELL), -(-w // CELL)

    def grid_of(mask, frac):
        pad = np.zeros((rows * CELL, cols * CELL), bool)
        pad[:h, :w] = mask
        return pad.reshape(rows, CELL, cols, CELL).mean(axis=(1, 3)) >= frac

    walk = grid_of(free, 0.55)
    pub = grid_of(public_px, 0.45) & walk

    # step legality, checked against the real pixels between cell centres
    blocked = np.ones((rows * CELL, cols * CELL), bool)
    blocked[:h, :w] = ~free
    half = CELL // 2
    cy = np.broadcast_to((np.arange(rows) * CELL + half)[:, None], (rows, cols))
    cx = np.broadcast_to((np.arange(cols) * CELL + half)[None, :], (rows, cols))

    blockE = np.zeros((rows, cols), bool)
    blockS = np.zeros((rows, cols), bool)
    for k in range(CELL + 1):
        blockE |= blocked[cy, np.clip(cx + k, 0, cols * CELL - 1)]
        blockS |= blocked[np.clip(cy + k, 0, rows * CELL - 1), cx]
    east = walk & np.roll(walk, -1, axis=1) & ~blockE
    east[:, -1] = False
    south = walk & np.roll(walk, -1, axis=0) & ~blockS
    south[-1, :] = False
    return rows, cols, walk, pub, east, south, doors

def connect_grid(walk, east, south, points, cell, max_gap=5, passes=6):
    """Guarantee the search grid is actually connected.

    Doors are carved at pixel level, but the coarse step test can still refuse
    the one step that would use a doorway. So: find every pocket that isn't
    part of the main network, and open a short run of cells to the nearest cell
    that is. Only short gaps are bridged — anything longer is a real wall, and
    stays one.
    """
    rows, cols = walk.shape
    opened = 0
    for _ in range(passes):
        parent = np.arange(rows * cols)

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        idx = np.arange(rows * cols).reshape(rows, cols)
        for r, c in zip(*np.nonzero(east)):
            a, b = find(idx[r, c]), find(idx[r, c + 1])
            if a != b:
                parent[a] = b
        for r, c in zip(*np.nonzero(south)):
            a, b = find(idx[r, c]), find(idx[r + 1, c])
            if a != b:
                parent[a] = b
        roots = np.array([find(i) for i in range(rows * cols)]).reshape(rows, cols)
        roots[~walk] = -1
        vals, counts = np.unique(roots[roots >= 0], return_counts=True)
        if len(vals) == 0:
            break
        main = vals[np.argmax(counts)]
        main_mask = roots == main

        # which pockets matter: anything a traced point sits in, plus anything
        # room-sized
        wanted = set()
        for p in points.values():
            c, r = int(p['x'] // cell), int(p['y'] // cell)
            if 0 <= r < rows and 0 <= c < cols and roots[r, c] >= 0 and roots[r, c] != main:
                wanted.add(int(roots[r, c]))
        for v, n in zip(vals, counts):
            if v != main and n >= 12:
                wanted.add(int(v))
        if not wanted:
            break

        dist, inds = ndi.distance_transform_edt(~main_mask, return_indices=True)
        did = 0
        for comp in wanted:
            sel = roots == comp
            dsel = np.where(sel, dist, np.inf)
            pos = np.unravel_index(np.argmin(dsel), dsel.shape)
            if not np.isfinite(dsel[pos]) or dsel[pos] > max_gap:
                continue
            r0, c0 = int(pos[0]), int(pos[1])
            r1, c1 = int(inds[0, r0, c0]), int(inds[1, r0, c0])
            # open the straight run of cells between the two
            n = max(abs(r1 - r0), abs(c1 - c0))
            prev = None
            for k in range(n + 1):
                rr = int(round(r0 + (r1 - r0) * k / max(n, 1)))
                cc = int(round(c0 + (c1 - c0) * k / max(n, 1)))
                walk[rr, cc] = True
                if prev is not None:
                    pr, pc = prev
                    if cc == pc + 1 and rr == pr:
                        east[pr, pc] = True
                    elif cc == pc - 1 and rr == pr:
                        east[rr, cc] = True
                    elif rr == pr + 1 and cc == pc:
                        south[pr, pc] = True
                    elif rr == pr - 1 and cc == pc:
                        south[rr, cc] = True
                    else:  # diagonal: open both legs of the corner
                        mr, mc = pr, cc
                        walk[mr, mc] = True
                        for (ar, ac), (br, bc) in [((pr, pc), (mr, mc)), ((mr, mc), (rr, cc))]:
                            if bc == ac + 1 and br == ar:
                                east[ar, ac] = True
                            elif bc == ac - 1 and br == ar:
                                east[br, bc] = True
                            elif br == ar + 1 and bc == ac:
                                south[ar, ac] = True
                            elif br == ar - 1 and bc == ac:
                                south[br, bc] = True
                prev = (rr, cc)
            did += 1
        opened += did
        if did == 0:
            break
    return opened


def b64(mask):
    return base64.b64encode(np.packbits(mask.astype(np.uint8).ravel()).tobytes()).decode('ascii')

if __name__ == '__main__':
    for floor in (sys.argv[1:] or ['lower', 'main', 'upper']):
        rows, cols, walk, pub, east, south, doors = planes(floor)
        pts_all = json.load(open(f'westlake-map/src/data/floors/{floor}.json'))['points']
        bridged = connect_grid(walk, east, south, pts_all, CELL)
        # connectivity report
        payload = {'floor': floor, 'cols': int(cols), 'rows': int(rows), 'cell': CELL,
                   'walk': b64(walk), 'pub': b64(pub), 'east': b64(east), 'south': b64(south),
                   'doors': [[int(x), int(y)] for x, y in doors]}
        path = f'westlake-map/src/data/floors/nav-{floor}.json'
        json.dump(payload, open(path, 'w'))
        import os
        pts = json.load(open(f'westlake-map/src/data/floors/{floor}.json'))['points']
        rooms = [p for p in pts.values() if p['kind'] == 'room']
        # reachability over the exported step planes
        parent = np.arange(rows * cols)
        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]; i = parent[i]
            return i
        idx = np.arange(rows * cols).reshape(rows, cols)
        for r, c in zip(*np.nonzero(east)):
            a_, b_ = find(idx[r, c]), find(idx[r, c + 1])
            if a_ != b_: parent[a_] = b_
        for r, c in zip(*np.nonzero(south)):
            a_, b_ = find(idx[r, c]), find(idx[r + 1, c])
            if a_ != b_: parent[a_] = b_
        roots = np.array([find(i) for i in range(rows * cols)]).reshape(rows, cols)
        roots[~walk] = -1
        vals, counts = np.unique(roots[roots >= 0], return_counts=True)
        main_root = vals[np.argmax(counts)]
        hit = 0
        for p in rooms:
            c, r = int(p['x'] // CELL), int(p['y'] // CELL)
            # strict: the cell the room label actually sits in (or its immediate
            # neighbours) must be on the network — a nearby-but-separate pocket
            # is exactly the failure this is meant to catch
            r0, r1 = max(0, r - 1), min(rows, r + 2); c0, c1 = max(0, c - 1), min(cols, c + 2)
            if (roots[r0:r1, c0:c1] == main_root).any(): hit += 1
        print(f'{floor}: {os.path.getsize(path)/1024:.0f}KB | walkable {walk.mean():.3f} '
              f'public {pub.sum()/max(walk.sum(),1):.2f} | doors {len(doors)} '
              f'| bridged {bridged} | rooms routable {hit}/{len(rooms)} ({100*hit/max(len(rooms),1):.0f}%)')
