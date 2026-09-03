"""Turn a scanned floor plan into a walkable-cell mask.

Walls are ink. Free space is paper. The catch is that the paper *outside* the
building is also free, so a route would happily shortcut across the lawn — so
the mask is clipped to the building footprint (ink dilated until the outline
closes, then hole-filled).
"""
import numpy as np, sys, json, base64
from PIL import Image
from scipy import ndimage as ndi

CELL = 6            # grid cell size in source px (matches navmesh.ts)
DARK = 170          # ink threshold
CLEARANCE_PX = 3    # keep this far off every wall
FOOTPRINT_DILATE = 14
CELL_FREE_FRAC = 0.72

def build(path):
    a = np.array(Image.open(path).convert('L'))
    ink = a < DARK
    ink = ndi.binary_closing(ink, structure=np.ones((3, 3)))

    # Building footprint: fatten the ink until the outer wall is a closed loop,
    # fill the inside, then shrink back.
    fat = ndi.binary_dilation(ink, structure=np.ones((3, 3)), iterations=FOOTPRINT_DILATE)
    filled = ndi.binary_fill_holes(fat)
    footprint = ndi.binary_erosion(filled, structure=np.ones((3, 3)), iterations=FOOTPRINT_DILATE)
    # keep the largest footprint blob (the school), drop title-block boxes etc.
    lab, n = ndi.label(footprint)
    if n > 1:
        sizes = ndi.sum(footprint, lab, range(1, n + 1))
        footprint = lab == (int(np.argmax(sizes)) + 1)

    free = (~ink) & footprint
    free = ndi.binary_erosion(free, structure=np.ones((3, 3)), iterations=CLEARANCE_PX)

    h, w = a.shape
    rows, cols = int(np.ceil(h / CELL)), int(np.ceil(w / CELL))
    pad = np.zeros((rows * CELL, cols * CELL), bool)
    pad[:h, :w] = free
    frac = pad.reshape(rows, CELL, cols, CELL).mean(axis=(1, 3))
    grid = frac >= CELL_FREE_FRAC
    return a, ink, footprint, grid

def components(grid):
    lab, n = ndi.label(grid, structure=np.ones((3, 3)))
    sizes = ndi.sum(grid, lab, range(1, n + 1)) if n else []
    return lab, n, sizes

if __name__ == '__main__':
    page = sys.argv[1]
    a, ink, footprint, grid = build(page)
    lab, n, sizes = components(grid)
    order = np.argsort(sizes)[::-1]
    print(page, f'grid {grid.shape} walkable {grid.mean():.3f} components {n}')
    print('  top comps:', [int(sizes[i]) for i in order[:8]])
    # preview
    up = np.kron(grid, np.ones((CELL, CELL), bool))[:a.shape[0], :a.shape[1]]
    rgb = np.stack([a] * 3, -1)
    rgb[up] = (0.45 * rgb[up] + 0.55 * np.array([40, 160, 220])).astype(np.uint8)
    Image.fromarray(rgb).resize((a.shape[1] // 3, a.shape[0] // 3)).save(f'/tmp/walk_{page.split(".")[0]}.png')

def export(page, out_json, floor_id):
    a, ink, footprint, grid = build(page)
    rows, cols = grid.shape
    flat = np.packbits(grid.astype(np.uint8).ravel())
    payload = {
        "floor": floor_id,
        "cols": int(cols),
        "rows": int(rows),
        "cell": CELL,
        "bits": base64.b64encode(flat.tobytes()).decode("ascii"),
    }
    with open(out_json, "w") as f:
        json.dump(payload, f)
    return grid, len(payload["bits"])

# Regenerate all three masks:
#   python3 tools/walkmask.py --all  (run from the project root, with the
#   rendered plan pages page0/page1/page2.png alongside)
if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == '--all':
    for page, fid in [('page1.png', 'lower'), ('page0.png', 'main'), ('page2.png', 'upper')]:
        _, n = export(page, f'src/data/floors/walkable-{fid}.json', fid)
        print(f'wrote src/data/floors/walkable-{fid}.json ({n/1024:.0f}KB base64)')
