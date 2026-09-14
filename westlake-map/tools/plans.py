"""Where the scanned plans come from, and what each page is.

Every tool in here used to name its own input file, and they disagreed:
`export_walls.py` wanted `private-source/main-level.jpg`, `mask4.py` wanted
`private-source/page0.png`. Same pixels, two names, and renaming one silently
broke the other. So the source lives in one place now, and the renderer that
produces it lives here too.

The pages are rendered out of the original PDF at 4x its 72 dpi user space —
288 dpi — because that is exactly the pixel size the shipped floor data was
built at (Main 3167x2448, Lower 3039x2448, Upper 3167x2448). Keeping it means
`PX_PER_FOOT` in src/lib/directions.ts, align3d.json and every traced point
stay valid across a rebuild. If you ever change ZOOM you invalidate all three.

    python3 tools/plans.py path/to/MAPWestlake.pdf

writes private-source/{floor}-level.png. private-source/ is gitignored: the
scans are the school's drawings and nothing derived from their pixels is
allowed into src/.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'private-source')
OUT_DIR = os.path.join(ROOT, 'src', 'data', 'floors')

FLOORS = ('lower', 'main', 'upper')

# Which PDF page draws which storey. The booklet is ordered Main, Lower, Upper —
# not bottom-to-top — so this mapping is not the identity and never was.
PDF_PAGE = {'main': 0, 'lower': 1, 'upper': 2}

# 4x the PDF's 72 dpi user space. See the module docstring before touching it.
ZOOM = 4


def page_path(floor):
    """The rendered scan for a floor. Accepts either extension, new name first."""
    for name in (f'{floor}-level.png', f'{floor}-level.jpg',
                 f'page{PDF_PAGE[floor]}.png'):
        p = os.path.join(ASSETS, name)
        if os.path.exists(p):
            return p
    raise SystemExit(
        f'no scan for the {floor} level in {ASSETS}.\n'
        f'Render one with:  python3 tools/plans.py <MAPWestlake.pdf>')


def render(pdf_path):
    """Render every page of the plan booklet into private-source/."""
    import pymupdf

    os.makedirs(ASSETS, exist_ok=True)
    doc = pymupdf.open(pdf_path)
    if len(doc) < 3:
        raise SystemExit(f'{pdf_path} has {len(doc)} pages; expected at least 3')
    matrix = pymupdf.Matrix(ZOOM, ZOOM)
    for floor in FLOORS:
        page = doc[PDF_PAGE[floor]]
        # Greyscale: the scans carry no colour, and the whole pipeline
        # thresholds them anyway.
        pix = page.get_pixmap(matrix=matrix, colorspace=pymupdf.csGRAY)
        out = os.path.join(ASSETS, f'{floor}-level.png')
        pix.save(out)
        print(f'  {floor}: {out}  {pix.width}x{pix.height}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    render(sys.argv[1])
