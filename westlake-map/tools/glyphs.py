"""Finding room numbers the pocket reader cannot see, and a second opinion on all of them.

`read_plan.py` reads a room's number as the holes in its sealed free-space
pocket. That is exact when it applies, and it fails in three ways that between
them account for most of the rooms it never read:

  * the number TOUCHES A WALL, so it is part of the wall's ink and not a hole
    (290D, 283D, 280L on Main);
  * the room LEAKS into its neighbours or the corridor through a gap in the
    scan, so the pocket is too big to be one room and was skipped (the whole
    226-234 row on Main);
  * the text is set at an ANGLE -- the 254x wing on Main runs at ~35 degrees,
    and the old crop only knew upright and vertical.

`find_words` comes at it from the ink instead of from the room. Take the ink
minus its long straight runs (the same line opening `export_walls.py` uses, so
the two tools agree about what a wall is), and keep the glyph-sized pieces left
over. A wall stub is glyph-sized too, which is what the RING test is for: a
printed character is surrounded by open floor, a stub is surrounded by more
wall. Group what survives into words by spacing, inside one pocket, and turn
each word upright along the line through its glyph centres. None of that needs
the pocket to be sealed or the glyphs to be free-floating.

The second half is the classifier the roadmap asked for. Tesseract has no prior
that says a room number is digits in one stencil font, which is why it reads
`306` as `308` -- confidently, 0.67, the one misread above the apply threshold
-- and why it scores perfectly legible `234` at 0.5. But this map prints every
digit in one font at one size, and the reads tesseract IS sure of supply a few
hundred labelled examples of it. So `Templates` learns the font from the map
itself: segment each confident word into glyphs, and keep the glyphs only when
the count matches the text. Every other crop is then classified by nearest
neighbour against those examples. Held-out accuracy on the learned digits is
~97%.

It does not replace tesseract; it is an independent second reader. The two
fail differently -- tesseract on 6/8/3 and on glyph shapes it has no prior for,
the templates on letters (there are too few confident suffixes to learn them)
and on bad segmentation -- so when they AGREE, that agreement is strong evidence
in a way neither score alone is. And when the templates are sure and tesseract
disagrees, the read is disputed rather than applied.
"""

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

# --- what counts as a glyph ---------------------------------------------------
# Same size band as read_plan.GLYPH_*, but orientation-free: a glyph in a
# vertical or diagonal word is as tall as it is wide in the other direction.
GLYPH_LONG = (13, 46)
GLYPH_SHORT = (3, 44)
GLYPH_PX = (20, 1800)
# Pixels of ring examined around each piece of ink, and the share of that ring
# that has to be open floor. Printed text sits in open floor; a wall stub left
# over by the line opening sits against more wall.
RING = 3
RING_FREE = 0.5
# Two glyphs belong to one word if the gap between their boxes is at most this
# fraction of the glyph size, and their sizes are within this ratio.
WORD_GAP = 0.7
WORD_SIZE_RATIO = 1.5
MAX_WORD_GLYPHS = 6
# An upright word crop must have the shape of a room number: 3-4 characters.
WORD_ASPECT = (1.15, 5.5)
WORD_HEIGHT = (11, 48)
# Within this many degrees of axis-aligned, snap: a 3-degree "tilt" is the
# scanner, not the drawing, and rotating would only blur the glyphs.
SNAP_DEG = 10

# --- the classifier ---------------------------------------------------------
NORM_H, NORM_W = 24, 16
# A digit is about 0.62 of its height wide in this font. A connected blob wider
# than one glyph is several glyphs touching, split at the thinnest columns.
GLYPH_ASPECT = 0.62
# Template opinions this good are trusted to dispute tesseract or, on their
# own, to back a read that a traced point already claims.
SURE_SCORE = 0.9
SURE_MARGIN = 0.1
# The weakest template score at which an agreement with tesseract counts.
AGREE_SCORE = 0.75


# ------------------------------------------------------------- finding ----
def find_words(ink, lines, pockets):
    """Glyph-sized non-wall ink, grouped into words.

    `pockets` is the labelled free space (0 = ink). Returns (glyph labels,
    words), each word a list of glyph dicts carrying the pocket it is printed in.
    """
    text = ink & ~lines
    gl, n = ndi.label(text, structure=np.ones((3, 3)))
    sizes = np.bincount(gl.ravel(), minlength=n + 1)
    glyphs = []
    ring_se = np.ones((3, 3))
    for i, o in enumerate(ndi.find_objects(gl)):
        h, w = o[0].stop - o[0].start, o[1].stop - o[1].start
        if not (GLYPH_LONG[0] <= max(h, w) <= GLYPH_LONG[1]
                and GLYPH_SHORT[0] <= min(h, w) <= GLYPH_SHORT[1]
                and GLYPH_PX[0] <= sizes[i + 1] <= GLYPH_PX[1]):
            continue
        sl = (slice(max(0, o[0].start - RING), o[0].stop + RING),
              slice(max(0, o[1].start - RING), o[1].stop + RING))
        me = gl[sl] == i + 1
        ring = ndi.binary_dilation(me, ring_se, RING) & ~me
        around = pockets[sl][ring]
        free = around[around > 0]
        if len(free) < RING_FREE * ring.sum():
            continue
        vals, counts = np.unique(free, return_counts=True)
        glyphs.append({
            'id': i + 1, 'box': o, 'pocket': int(vals[np.argmax(counts)]),
            'size': max(h, w),
            'cy': (o[0].start + o[0].stop) / 2.0, 'cx': (o[1].start + o[1].stop) / 2.0,
        })

    parent = list(range(len(glyphs)))

    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    if glyphs:
        centres = np.array([(g['cy'], g['cx']) for g in glyphs])
        for a, b in cKDTree(centres).query_pairs(70):
            ga, gb = glyphs[a], glyphs[b]
            if ga['pocket'] != gb['pocket']:
                continue
            sa, sb = ga['size'], gb['size']
            if max(sa, sb) > WORD_SIZE_RATIO * min(sa, sb):
                continue
            ba, bb = ga['box'], gb['box']
            dy = max(0, max(ba[0].start, bb[0].start) - min(ba[0].stop, bb[0].stop))
            dx = max(0, max(ba[1].start, bb[1].start) - min(ba[1].stop, bb[1].stop))
            if np.hypot(dx, dy) <= WORD_GAP * min(sa, sb):
                parent[root(a)] = root(b)

    groups = {}
    for i, g in enumerate(glyphs):
        groups.setdefault(root(i), []).append(g)
    return gl, [w for w in groups.values() if len(w) <= MAX_WORD_GLYPHS]


def word_box(word):
    y0 = min(g['box'][0].start for g in word)
    y1 = max(g['box'][0].stop for g in word)
    x0 = min(g['box'][1].start for g in word)
    x1 = max(g['box'][1].stop for g in word)
    return y0, y1, x0, x1


def upright_crops(gl, word, vertical_aspect):
    """The word's ink turned so it reads left to right, as [(angle, crop)].

    The angle comes from the line through the glyph centres. Which way up a
    rotated word reads is not knowable from the crop, so both are returned and
    the reader lets the grammar decide -- as read_plan does for vertical text.
    """
    y0, y1, x0, x1 = word_box(word)
    m = np.isin(gl[y0:y1, x0:x1], [g['id'] for g in word])
    if len(word) >= 2:
        c = np.array([(g['cy'], g['cx']) for g in word])
        vy, vx = np.linalg.svd(c - c.mean(0), full_matrices=False)[2][0]
        ang = float(np.degrees(np.arctan2(vy, vx)))
        ang = ((ang + 90) % 180) - 90
    else:
        # One blob: glyphs touching each other. Its shape says which way it runs.
        ang = 90.0 if (y1 - y0) > (x1 - x0) * vertical_aspect else 0.0
    for snap in (0.0, 90.0, -90.0):
        if abs(ang - snap) < SNAP_DEG:
            ang = snap
    if ang == -90.0:
        ang = 90.0
    out = []
    for a in ([0.0] if ang == 0.0 else [ang, ang - 180.0]):
        r = np.pad(m, 3)
        if a == 90.0:
            r = np.rot90(r, 1)
        elif a == -90.0:
            r = np.rot90(r, -1)
        elif a:
            r = ndi.rotate(r.astype(np.float32), a, reshape=True, order=1) > 0.45
        ys, xs = np.nonzero(r)
        if not len(ys):
            continue
        r = r[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        h, w = r.shape
        if WORD_HEIGHT[0] <= h <= WORD_HEIGHT[1] and WORD_ASPECT[0] <= w / h <= WORD_ASPECT[1]:
            out.append((a, r))
    return out


# ---------------------------------------------------------- classifying ----
def segment(crop):
    """An upright word crop as its glyphs, left to right.

    A blob wider than one glyph is several glyphs that touch; it is cut into as
    many pieces as its width implies, each cut at the thinnest column near
    where a glyph boundary should fall.
    """
    lab, _ = ndi.label(crop, structure=np.ones((3, 3)))
    height = crop.shape[0]
    parts = []
    for j, o in enumerate(ndi.find_objects(lab)):
        g = lab[o] == j + 1
        h, w = g.shape
        if g.sum() < 15 or h < 0.45 * height:
            continue  # specks, a door-tag dot
        k = int(round(w / (GLYPH_ASPECT * h))) if w > 0.95 * h else 1
        if k <= 1:
            parts.append((o[1].start, g))
            continue
        profile = g.sum(0).astype(float)
        cuts = [0]
        slack = max(1, int(0.36 * w / k))
        for c in range(1, k):
            mid = int(c * w / k)
            lo, hi = max(1, mid - slack), min(w - 1, mid + slack)
            cuts.append(lo + int(np.argmin(profile[lo:hi + 1])) if hi > lo else mid)
        cuts.append(w)
        for a, b in zip(cuts, cuts[1:]):
            if g[:, a:b].sum() >= 10:
                parts.append((o[1].start + a, g[:, a:b]))
    parts.sort(key=lambda p: p[0])
    return [p[1] for p in parts]


def features(glyph):
    """A glyph as a unit vector: its shape at a fixed size, plus its aspect."""
    ys, xs = np.nonzero(glyph)
    g = glyph[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = g.shape
    # Pad to the normalised aspect before resizing, so a 1 stays thin.
    tw = max(w, int(round(h * NORM_W / NORM_H)))
    th = max(h, int(round(w * NORM_H / NORM_W)))
    p = np.zeros((th, tw), np.float32)
    p[(th - h) // 2:(th - h) // 2 + h, (tw - w) // 2:(tw - w) // 2 + w] = g
    im = Image.fromarray((p * 255).astype(np.uint8)).resize((NORM_W, NORM_H), Image.BILINEAR)
    v = ndi.gaussian_filter(np.asarray(im, np.float32) / 255.0, 0.8)
    v -= v.mean()
    n = np.linalg.norm(v)
    return np.concatenate([(v / n if n else v).ravel(), [0.6 * np.log(w / h)]])


class Templates:
    """The map's own font, learned from the reads tesseract was sure of."""

    def __init__(self):
        self.X = []
        self.Y = []

    def learn(self, crop, text):
        """Add a confidently-read word's glyphs. Ignored unless they segment cleanly."""
        glyphs = segment(crop)
        if len(glyphs) != len(text):
            return
        for ch, g in zip(text, glyphs):
            if ch.isdigit():  # too few confident suffix letters to learn from
                self.X.append(features(g))
                self.Y.append(ch)

    def freeze(self):
        self.X = np.array(self.X)
        self.Y = np.array(self.Y)
        self.classes = sorted(set(self.Y.tolist()))

    def __len__(self):
        return len(self.Y)

    def heldout_accuracy(self):
        """Leave-one-out nearest-neighbour accuracy: how well the font was learned."""
        if len(self.Y) < 2:
            return 0.0
        sim = self.X @ self.X.T
        np.fill_diagonal(sim, -np.inf)
        return float((self.Y[sim.argmax(1)] == self.Y).mean())

    def glyph(self, g):
        """(char, score, margin over the runner-up class)."""
        s = self.X @ features(g)
        best = sorted(((float(s[self.Y == c].max()), c) for c in self.classes), reverse=True)
        return best[0][1], best[0][0], best[0][0] - best[1][0]

    def read(self, crop):
        """The three digits of a room number, plus whether a suffix letter follows.

        Returns (digits, has_suffix, score, margin) -- score and margin are the
        weakest glyph's -- or None when the crop does not segment as 3-4 glyphs.
        """
        if not len(self.Y):
            return None
        glyphs = segment(crop)
        if not 3 <= len(glyphs) <= 4:
            return None
        reads = [self.glyph(g) for g in glyphs[:3]]
        return (''.join(r[0] for r in reads), len(glyphs) == 4,
                min(r[1] for r in reads), min(r[2] for r in reads))


def second_opinion(templates, crop, text):
    """What the templates say about a tesseract read of this crop.

    'agree'    -- the templates read the same digits (and see a suffix exactly
                  when tesseract read one).
    'dispute'  -- the templates are sure of different digits.
    'unsure'   -- neither.
    Returns (verdict, template digits or '', score).
    """
    t = templates.read(crop)
    if t is None:
        return 'unsure', '', 0.0
    digits, suffix, score, margin = t
    if text[:3] == digits and (len(text) == 4) == suffix and score >= AGREE_SCORE:
        return 'agree', digits, score
    if text[:3] != digits and score >= SURE_SCORE and margin >= SURE_MARGIN:
        return 'dispute', digits, score
    return 'unsure', digits, score
