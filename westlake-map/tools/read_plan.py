"""Read the room numbers off the scanned plan, instead of tracing them by eye.

Every room position in this project was originally placed by a human clicking on
the scan. That is slow, and it is wrong in ways nobody can see: on the Main
level the traced points for 216, 218, 220 and 224 each sat one room short of
the number they claimed, so asking the app for 220 walked you to 218. Nothing in
the pipeline could catch that, because the pipeline never looked at the number.

This does. The idea that makes it work is small:

    A ROOM'S PRINTED NUMBER IS EXACTLY THE SET OF HOLES IN ITS POCKET.

`export_rooms.py` already establishes that the plans draw every door closed, so
flooding the free space gives one sealed pocket per room. Fill that pocket's
holes and subtract the pocket back off, and what is left is precisely the ink
that is *printed inside that room* and touching nothing else — the number, and
nothing but the number. No line-opening, no stroke-width heuristic, no
thresholding of "text-like" components, and crucially no damage to the glyphs:
the earlier attempt subtracted the long-line skeleton to isolate text, which
also ate the vertical stroke of every 1 and clipped the 4s.

What comes out is a 42x27 crop of clean, isolated digits. That is a thing OCR
can actually read. The rest is bookkeeping:

  * dominant text size  — a room may also contain a fixture symbol or a door
    tag; keep only the glyphs whose height matches the median, which is the
    room number because the number is the largest text drawn inside a room.
  * rotation            — narrow rooms have their number set vertically, which
    the crop's aspect ratio gives away. Both rotations are tried and the one
    that reads as a room number wins.
  * voting              — the same crop is put to tesseract at two scales, with
    and without a stroke-thickening dilation, under three page-segmentation
    modes. Reads that match the room-number grammar are weighted double. A
    single rendering is a coin flip on this stencil font; the vote is not.
  * grammar             — `[1-4]\\d\\d[A-Z]?`. The building numbers 100s on the
    lower level, 200s on the main, 300s and 400s on the upper, and a suffix
    letter for subdivided rooms. Anything else is not a room number and is
    dropped rather than guessed at.

The output is a REPORT, not a replacement. Reading a scan is not reliable enough
to overwrite hand-checked data unasked, so every room comes out tagged with what
the reader found and what the shipped data says:

    confirmed  the scan and the traced label agree.
    corrected  both are readable and they disagree -- the scan wins, because
               the scan is the building and the traced label is somebody's
               memory of it. Recorded so a human can see every one.
    found      a number in a pocket no traced point claimed: a missing room.
    unread     nothing legible; the traced label is kept as-is.

Positions are taken from geometry either way. A traced point sits whereever the
tracer clicked, which is usually on the number and sometimes on a wall; the
reader instead returns the pocket's POLE OF INACCESSIBILITY -- the interior
point furthest from any wall -- which is inside the room by construction and
sits in open floor, which is where a route should terminate.

Usage:

    python3 tools/read_plan.py                  # report only, writes nothing
    python3 tools/read_plan.py --apply          # update src/data/floors/*.json
    python3 tools/read_plan.py --render main    # + a PNG of every read
"""

import hashlib
import io
import json
import os
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

import export_walls as ew
import glyphs as gx
import plans

# --- what counts as a glyph ---------------------------------------------------
# Room numbers are set at a consistent size across all three sheets: ~27 px tall
# at 288 dpi. The bounds are wide enough for the smaller text in the subdivided
# 254x/257x suites and tight enough to reject both the hairline door tags and
# the big landmark lettering ("LIBRARY", "PRACTICE GYM").
GLYPH_H = (13, 46)
GLYPH_W = (3, 44)
GLYPH_PX = (20, 1800)
# A room may contain a fixture symbol as well as its number. Keep the glyphs
# whose height is within this fraction of the median -- the number is the
# dominant text, so the median is its size.
SIZE_BAND = 0.35
# Below this much ink there is nothing printed in the pocket worth reading.
MIN_MARK_PX = 40
# Pockets outside this area are not single rooms: below is a wall gap, above is
# rooms that leaked together through a gap in the scan. Matches export_rooms.py.
MIN_POCKET_PX = 600
MAX_POCKET_PX = 120000
# A crop this much taller than wide is text set vertically in a narrow room.
VERTICAL_ASPECT = 1.3

# --- the room-number grammar --------------------------------------------------
ROOM_RE = re.compile(r'^[1-4]\d\d[A-Z]?$')
# Which leading digits belong on which sheet. The upper level carries both the
# 300s and the 400s (the gyms, the PAC and the auditorium are numbered 4xx), so
# this is not simply one digit per floor.
FLOOR_DIGITS = {'lower': ('1',), 'main': ('2',), 'upper': ('3', '4')}

WHITELIST = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

# How sure the reader has to be before --apply will act on a read.
# Measured across all three sheets: every read that turned out to be a misread
# scored 0.33 or below, and every correction that held up under inspection
# scored 0.50 or above. There is a real gap there, which is what makes a fixed
# threshold defensible rather than a guess.
MIN_APPLY_CONF = 0.5
#
# That held for tesseract alone until it didn't: Upper's 306 read as "308" at
# 0.67, in the wrong room. Since then every read also gets a second, independent
# opinion from templates learned off this map's own font (tools/glyphs.py):
#   agree        -> both readers say the same thing: AGREE_CONF, applied.
#                   Digits only: the suffix letter of "288B" is tesseract's
#                   alone, so a suffixed read keeps tesseract's own score.
#   dispute      -> the templates are sure of different digits: capped at
#                   DISPUTED_CONF, so it goes to review instead of the map.
#   corroborated -> tesseract got nothing, the templates are sure, AND a traced
#                   point already claims that number right there: two
#                   independent sources, CORROBORATED_CONF, applied.
#   template     -> the templates alone: TEMPLATE_CONF, a suggestion only.
AGREE_CONF = 0.75
CORROBORATED_CONF = 0.6
TEMPLATE_CONF = 0.3
DISPUTED_CONF = 0.25
# How close a traced point has to be to a read to be "the same room", for
# reads made outside a room-sized pocket.
NEAR_PX = 60

# Human (or by-eye) verdicts on reads the tool cannot settle itself. Survives
# re-runs, which a click in the app does not: see the file for the format.
DECISIONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'review-decisions.json')

# Tesseract runs are the whole cost of this tool -- twelve renderings per
# crop, ~0.35 s each. They run in parallel, one thread per tesseract (its own
# OpenMP threading only fights the pool), and are cached by crop on disk, so a
# re-run after a small change costs seconds rather than tens of minutes.
WORKERS = max(1, (os.cpu_count() or 2))
OCR_CACHE = os.path.join(plans.ASSETS, 'ocr-cache.json')
_cache = None
_cache_lock = threading.Lock()


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------- ocr ----
def _png(im):
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


def _load_cache():
    global _cache
    if _cache is None:
        try:
            _cache = json.load(open(OCR_CACHE))
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save_cache():
    if _cache is not None:
        os.makedirs(plans.ASSETS, exist_ok=True)
        with open(OCR_CACHE, 'w') as fh:
            json.dump(_cache, fh)


def _tesseract(arr, psm, scale, thicken):
    """One rendering of one crop, cached. `arr` is a bool mask, True where there is ink."""
    key = hashlib.sha1(np.packbits(arr).tobytes() + repr((arr.shape, psm, scale, thicken)).encode()).hexdigest()
    cache = _load_cache()
    with _cache_lock:
        if key in cache:
            return cache[key]
    out = _tesseract_run(arr, psm, scale, thicken)
    with _cache_lock:
        cache[key] = out
    return out


def _tesseract_run(arr, psm, scale, thicken):
    a = ndi.binary_dilation(arr, np.ones((3, 3)), thicken) if thicken else arr
    im = Image.fromarray(((~a) * 255).astype(np.uint8))
    im = im.resize((im.width * scale, im.height * scale), Image.LANCZOS)
    # Tesseract wants breathing room around the text or it clips the first glyph.
    page = Image.new('L', (im.width + 80, im.height + 80), 255)
    page.paste(im, (40, 40))
    try:
        p = subprocess.run(
            ['tesseract', 'stdin', 'stdout', '--psm', str(psm),
             '-c', f'tessedit_char_whitelist={WHITELIST}'],
            input=_png(page), capture_output=True, timeout=30,
            env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
    except (OSError, subprocess.TimeoutExpired):
        return ''
    return re.sub(r'\s+', '', p.stdout.decode('utf8', 'ignore').upper())


def read_crop(arr):
    """Vote across renderings. Returns (text, confidence 0..1).

    No single rendering of this stencil font is trustworthy -- the same crop
    reads '288C' at one scale and '2B8C' at another, because tesseract has no
    prior that says a room number is mostly digits. Weighting the reads that fit
    the grammar, and counting agreement across renderings, turns a coin flip
    into something with a usable confidence attached.
    """
    votes = {}
    total = 0
    for psm in (7, 8, 13):
        for scale in (4, 6):
            for thicken in (0, 1):
                t = _tesseract(arr, psm, scale, thicken)
                total += 1
                if not t:
                    continue
                votes[t] = votes.get(t, 0) + (2 if ROOM_RE.match(t) else 1)
    if not votes:
        return '', 0.0
    text, score = max(votes.items(),
                      key=lambda kv: (ROOM_RE.match(kv[0]) is not None, kv[1]))
    # Confidence is the share of the maximum achievable score, so a read that
    # every rendering agrees on and that fits the grammar approaches 1.
    return text, min(1.0, score / (2.0 * total))


# ------------------------------------------------------------ extraction ----
def marks_in_pocket(pocket, ink):
    """The ink printed inside a pocket: fill its holes, subtract the pocket."""
    return ndi.binary_fill_holes(pocket) & ~pocket & ink


def glyph_crop(marks):
    """Isolate the dominant run of text in a pocket and crop to it.

    Returns (crop, (cy, cx)) in pocket-local coordinates, or (None, None).
    """
    lab, n = ndi.label(marks, structure=np.ones((3, 3)))
    if not n:
        return None, None
    objs = ndi.find_objects(lab)
    sizes = np.bincount(lab.ravel(), minlength=n + 1)[1:]
    keep = []
    for i, o in enumerate(objs):
        h = o[0].stop - o[0].start
        w = o[1].stop - o[1].start
        if (GLYPH_H[0] <= h <= GLYPH_H[1] and GLYPH_W[0] <= w <= GLYPH_W[1]
                and GLYPH_PX[0] <= sizes[i] <= GLYPH_PX[1]):
            keep.append((i + 1, o, h))
    if not keep:
        return None, None
    med = float(np.median([k[2] for k in keep]))
    keep = [k for k in keep if abs(k[2] - med) <= SIZE_BAND * med]
    if not keep:
        return None, None
    sub = np.zeros_like(marks)
    for i, _, _ in keep:
        sub |= (lab == i)
    y0 = min(o[0].start for _, o, _ in keep)
    y1 = max(o[0].stop for _, o, _ in keep)
    x0 = min(o[1].start for _, o, _ in keep)
    x1 = max(o[1].stop for _, o, _ in keep)
    return sub[y0:y1, x0:x1], ((y0 + y1) / 2.0, (x0 + x1) / 2.0)


def best_read(options):
    """Read each orientation of a crop; the grammar, then the vote, picks one.

    Returns (text, conf, crop it was read from).
    """
    best = ('', 0.0, options[0] if options else None)
    for opt in options:
        text, conf = read_crop(opt)
        if (ROOM_RE.match(text) is not None, conf) > (ROOM_RE.match(best[0]) is not None, best[1]):
            best = (text, conf, opt)
    return best


def pocket_crops(pocket, ink):
    """The upright crop(s) of the number printed in one pocket, and its centre."""
    marks = marks_in_pocket(pocket, ink)
    if marks.sum() < MIN_MARK_PX:
        return [], None
    crop, centre = glyph_crop(marks)
    if crop is None or crop.size == 0:
        return [], None
    h, w = crop.shape
    if h > w * VERTICAL_ASPECT:
        # Set vertically. Which way up is not knowable from the crop, so read
        # both and let the grammar decide.
        return [np.rot90(crop, -1), np.rot90(crop, 1)], centre
    return [crop], centre


def read_pocket(pocket, ink):
    """Read the room number printed in one pocket. Returns (text, conf, centre)."""
    options, centre = pocket_crops(pocket, ink)
    text, conf, _ = best_read(options)
    return text, conf, centre


def pole_of_inaccessibility(pocket):
    """The interior point furthest from any wall, in pocket-local coords.

    A route should end in open floor, not against a partition, and a label
    should be drawn where there is room for it. The distance transform's
    argmax gives both, and is inside the pocket by construction -- unlike a
    centroid, which for an L-shaped room lands in the wall.
    """
    dist = ndi.distance_transform_edt(pocket)
    idx = int(np.argmax(dist))
    cy, cx = np.unravel_index(idx, dist.shape)
    return float(cy), float(cx), float(dist[cy, cx])


# ---------------------------------------------------------------- floors ----
def storey_pockets(floor):
    """Every sealed free-space pocket on a storey, plus the ink that made it."""
    grey, ink, page_fp = ew.ink_and_footprint(plans.page_path(floor))
    ink_in_page = ink & page_fp
    lines, per = ew.long_lines(ink_in_page)
    hatch = ew.hatch_mask(ink_in_page, per)
    pts = ew.room_points(floor)
    st = ew.storey_mask(ink_in_page, lines, pts, grey.shape) & ~hatch
    free = (~ink) & page_fp & st
    lab, n = ndi.label(free, structure=np.ones((3, 3)))
    return ink, ink_in_page, lines, lab, n


def traced_rooms(floor):
    """The shipped room points, as {id: point}."""
    path = os.path.join(plans.OUT_DIR, f'{floor}.json')
    d = json.load(open(path))
    return {pid: p for pid, p in d['points'].items() if p.get('kind') == 'room'}


def _ocr(entries):
    """Read every entry's crop options, in parallel."""
    def one(e):
        return best_read(e['_options'])
    with ThreadPoolExecutor(WORKERS) as ex:
        for e, (text, conf, crop) in zip(entries, ex.map(one, entries)):
            e['text'], e['conf'], e['_crop'] = text, round(conf, 3), crop


def read_floor(floor):
    """Every room number tesseract can find on a storey -- pockets, then words.

    The template opinion is added later by `main`, once all three storeys have
    been read, because the templates learn from all of them at once.
    """
    log(f'{floor}: reading {os.path.relpath(plans.page_path(floor), plans.ROOT)}')
    ink, ink_in_page, lines, lab, n = storey_pockets(floor)
    sizes = np.bincount(lab.ravel(), minlength=n + 1)[1:]
    objs = ndi.find_objects(lab)

    traced = traced_rooms(floor)
    # Which pocket each traced point falls in. A traced position sits on the
    # printed number, which is ink and so belongs to no pocket; take whichever
    # pocket dominates the window around it, as export_rooms.py does.
    owner = {}
    for pid, p in traced.items():
        cx, cy = int(p['x']), int(p['y'])
        y0, y1 = max(0, cy - 26), min(lab.shape[0], cy + 26)
        x0, x1 = max(0, cx - 26), min(lab.shape[1], cx + 26)
        win = lab[y0:y1, x0:x1]
        vals, counts = np.unique(win[win > 0], return_counts=True)
        if len(vals):
            owner.setdefault(int(vals[np.argmax(counts)]), []).append(pid)

    def room_sized(comp):
        return MIN_POCKET_PX <= int(sizes[comp - 1]) <= MAX_POCKET_PX

    # --- pass 1: the number as the holes in a sealed pocket -----------------
    pockets, poles = [], {}
    for comp in range(1, n + 1):
        sl = objs[comp - 1]
        if sl is None or not room_sized(comp):
            continue
        pad = (slice(max(0, sl[0].start - 3), sl[0].stop + 3),
               slice(max(0, sl[1].start - 3), sl[1].stop + 3))
        pocket = (lab[pad] == comp)
        options, _ = pocket_crops(pocket, ink[pad])
        cy, cx, clear = pole_of_inaccessibility(pocket)
        poles[comp] = (int(round(cx + pad[1].start)), int(round(cy + pad[0].start)), round(clear, 1))
        if options:
            pockets.append({
                'method': 'pocket', 'comp': comp, 'area': int(sizes[comp - 1]),
                'x': poles[comp][0], 'y': poles[comp][1], 'clearance': poles[comp][2],
                'traced': owner.get(comp, []), '_options': options,
            })
    _ocr(pockets)

    # --- pass 2: words found in the ink, for everything pass 1 missed ---------
    digits = FLOOR_DIGITS[floor]

    def valid(text):
        # A read is only a room number if it fits the grammar AND starts with a
        # digit this storey actually uses. "283" read off the Upper sheet is a
        # misread, not a room on the wrong floor -- the numbering is by storey.
        return bool(ROOM_RE.match(text)) and text[0] in digits

    settled = {e['comp'] for e in pockets if valid(e['text'])}
    gl, words = gx.find_words(ink_in_page, lines, lab)
    found = []
    for word in words:
        comp = word[0]['pocket']
        if comp in settled:
            continue  # this room's number was already read as its holes
        options = [crop for _, crop in gx.upright_crops(gl, word, VERTICAL_ASPECT)]
        if not options:
            continue
        y0, y1, x0, x1 = gx.word_box(word)
        wx, wy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        if comp in poles:
            # A room-sized pocket: anchor at its open floor, as pass 1 does.
            x, y, clear = poles[comp]
            claims = owner.get(comp, [])
        else:
            # A leaky pocket spanning several rooms: the text is the only
            # locator there is. Only a traced point sitting right on this word
            # is taken as claiming it.
            x, y, clear = int(round(wx)), int(round(wy)), 0.0
            claims = [pid for pid, p in traced.items()
                      if np.hypot(p['x'] - wx, p['y'] - wy) <= NEAR_PX / 2]
        found.append({
            'method': 'word', 'comp': comp, 'area': int(sizes[comp - 1]) if comp else 0,
            'x': x, 'y': y, 'clearance': clear, 'traced': claims,
            'near': [pid for pid, p in traced.items()
                     if np.hypot(p['x'] - wx, p['y'] - wy) <= NEAR_PX],
            '_options': options,
        })
    _ocr(found)

    reads = pockets + found
    for e in reads:
        e['valid'] = valid(e['text'])
    log(f'  {floor}: {len(pockets)} pockets and {len(found)} loose words examined')
    return reads


def learn_templates(all_reads):
    """The font, from every read tesseract was sure of, on every storey."""
    t = gx.Templates()
    for reads in all_reads.values():
        for e in reads:
            if e['valid'] and e['conf'] >= AGREE_CONF and e.get('_crop') is not None:
                t.learn(e['_crop'], e['text'])
    t.freeze()
    log(f'templates: {len(t)} glyphs learned, held-out accuracy {t.heldout_accuracy():.1%}')
    return t


def second_opinion(floor, reads, templates):
    """Fold the templates' opinion into each read's confidence. See AGREE_CONF."""
    digits = FLOOR_DIGITS[floor]
    traced = traced_rooms(floor)
    extra = []
    for e in reads:
        e['tesseract'] = e['conf']
        if e['valid']:
            verdict, tdig, score = gx.second_opinion(templates, e['_crop'], e['text'])
            e['opinion'], e['template'] = verdict, tdig
            # The templates never learned the suffix letters, so on "288B" they
            # vouch for the 288 and nothing else -- tesseract alone read that B,
            # and on Main it read a B as an E. A suffix keeps tesseract's score.
            if verdict == 'agree' and len(e['text']) == 3:
                e['conf'] = max(e['conf'], AGREE_CONF)
            elif verdict == 'dispute':
                e['conf'] = min(e['conf'], DISPUTED_CONF)
                # Put the templates' reading in front of a human as well, so the
                # review shows both candidates rather than only the doubtful one.
                alt = tdig + e['text'][3:]
                if alt[0] in digits and ROOM_RE.match(alt):
                    extra.append({**e, 'text': alt, 'conf': TEMPLATE_CONF,
                                  'tesseract': 0.0, 'opinion': 'template'})
            continue
        # Tesseract found no room number at all. The templates may, but only
        # the digits: they never learned the suffix letters.
        best = None
        for opt in e['_options']:
            t = templates.read(opt)
            if (t and not t[1] and t[0][0] in digits
                    and t[2] >= gx.SURE_SCORE and t[3] >= gx.SURE_MARGIN
                    and (best is None or t[2] > best[2])):
                best = t
        if best is None:
            continue
        text = best[0]
        claimed = {(traced[pid].get('label') or pid) for pid in e['traced'] + e.get('near', [])}
        e.update(text=text, valid=True, template=text,
                 opinion='corroborated' if text in claimed else 'template',
                 conf=CORROBORATED_CONF if text in claimed else TEMPLATE_CONF)
        if text in claimed:
            # The traced point that agrees is, by definition, claiming this read.
            e['traced'] = sorted(set(e['traced']) | {pid for pid in e.get('near', [])
                                                     if (traced[pid].get('label') or pid) == text})
    reads.extend(extra)


def settle_conflicts(reads, min_conf=MIN_APPLY_CONF):
    """Two confident reads that cannot both be true are both demoted to review.

    One number read confidently in two different rooms, or two different
    numbers read confidently at one spot: at least one of each pair is wrong,
    and nothing here says which. Picking the higher score would be a coin flip
    dressed up as a decision -- in the 160s row on Lower it put 165 in 169's room.
    """
    sure = [e for e in reads if e['valid'] and e['conf'] >= min_conf]
    bad = set()
    for i, a in enumerate(sure):
        for b in sure[i + 1:]:
            d = np.hypot(a['x'] - b['x'], a['y'] - b['y'])
            if (a['text'] == b['text'] and d > NEAR_PX) or (a['text'] != b['text'] and d < NEAR_PX / 3):
                bad.update((id(a), id(b)))
    for e in sure:
        if id(e) in bad:
            e['conf'] = min(e['conf'], TEMPLATE_CONF)
            e['opinion'] = 'conflict'


def _render(floor, reads):
    """A contact sheet of every read, for eyeballing what the reader saw."""
    out = os.path.join(plans.ASSETS, f'read-{floor}.png')
    im = Image.open(plans.page_path(floor)).convert('RGB')
    from PIL import ImageDraw
    d = ImageDraw.Draw(im)
    for r in reads:
        if not r['text']:
            continue
        colour = (0, 150, 0) if r['valid'] and r['conf'] >= MIN_APPLY_CONF else (200, 0, 0)
        d.ellipse([r['x'] - 9, r['y'] - 9, r['x'] + 9, r['y'] + 9], outline=colour, width=3)
        d.text((r['x'] + 12, r['y'] - 8), f"{r['text']} {r['conf']:.2f}", fill=colour)
    im.save(out)
    log(f'  wrote {out}')


# ------------------------------------------------------------- decisions ----
def load_decisions():
    try:
        d = json.load(open(DECISIONS))
    except OSError:
        return {}
    return {k: v for k, v in d.items() if k in plans.FLOORS}


def _matches(entry, decision):
    return (entry['text'] == decision['text']
            and np.hypot(entry['x'] - decision['x'], entry['y'] - decision['y']) <= NEAR_PX * 2)


# --------------------------------------------------------------- reports ----
def reconcile(floor, reads, decisions=None):
    """Match what was read against what is shipped, and classify every room."""
    traced = traced_rooms(floor)
    rejects = (decisions or {}).get('reject', [])

    confirmed, corrected, found, unread, rejected = [], [], [], [], []
    seen = set()
    for r in reads:
        if not r['valid']:
            continue
        if any(_matches(r, d) for d in rejects):
            rejected.append(r)
            continue
        claims = r['traced']
        labels = {traced[pid].get('label') or pid for pid in claims}
        if r['text'] in labels:
            confirmed.append(r)
            seen.update(claims)
        elif claims:
            r['was'] = sorted(labels)
            corrected.append(r)
            seen.update(claims)
        else:
            found.append(r)
    for pid, p in traced.items():
        if pid not in seen:
            unread.append({'id': pid, 'label': p.get('label') or pid,
                           'x': int(p['x']), 'y': int(p['y'])})
    return {'confirmed': confirmed, 'corrected': corrected,
            'found': found, 'unread': unread, 'rejected': rejected}


def _public(e):
    return {k: v for k, v in e.items() if not k.startswith('_')}


def main(argv):
    apply_changes = '--apply' in argv
    render = '--render' in argv
    min_conf = MIN_APPLY_CONF
    for a in argv:
        if a.startswith('--min-conf='):
            min_conf = float(a.split('=', 1)[1])
    floors = [a for a in argv if a in plans.FLOORS] or list(plans.FLOORS)

    # The templates learn from every storey, so read them all before judging any.
    reads = {}
    try:
        for floor in floors:
            reads[floor] = read_floor(floor)
    finally:
        _save_cache()
    templates = learn_templates(reads)

    decisions = load_decisions()
    report = {}
    for floor in floors:
        second_opinion(floor, reads[floor], templates)
        settle_conflicts(reads[floor], min_conf)
        if render:
            _render(floor, reads[floor])
        r = reconcile(floor, reads[floor], decisions.get(floor))
        report[floor] = r
        valid = [x for x in reads[floor] if x['valid']]
        rejected = {id(x) for x in r['rejected']}
        sure = {x['text'] for x in valid if x['conf'] >= min_conf and id(x) not in rejected}
        log(f'  {floor}: {len(valid)} room numbers read, {len(sure)} distinct confidently')
        log(f'    confirmed {len(r["confirmed"])}  corrected {len(r["corrected"])}  '
            f'new {len(r["found"])}  unread {len(r["unread"])}  rejected {len(r["rejected"])}')
        for c in r['corrected']:
            log(f'      traced {"/".join(c["was"])} -> scan reads {c["text"]} '
                f'(conf {c["conf"]:.2f}, {c.get("opinion", "")}) at {c["x"]},{c["y"]}')
        if r['found']:
            log('      new: ' + ', '.join(f'{f["text"]}@{f["x"]},{f["y"]}' for f in r['found']))

    path = os.path.join(plans.ASSETS, 'read-report.json')
    with open(path, 'w') as fh:
        json.dump({f: {k: ([_public(e) for e in v] if isinstance(v, list) else v)
                       for k, v in r.items()} for f, r in report.items()}, fh, indent=1)
    log(f'wrote {os.path.relpath(path, plans.ROOT)}')

    write_app_report(report)
    if apply_changes:
        apply_report(report, min_conf, decisions)


def apply_report(report, min_conf=MIN_APPLY_CONF, decisions=None):
    """Rebuild the numbered rooms of each floor from what the scan says.

    Not a per-point patch, which is the obvious implementation and is wrong. The
    Main level's 214-224 column is traced one room short all the way down: the
    point calling itself 216 sits in the room printed 214, 218 sits in 216, and
    so on. Patching each point in place would relabel 216 to "214" while the
    point actually called 214 kept its name, and the floor would end up with two
    of them. The shift only resolves if the whole numbered set is rebuilt at
    once from the reads.

    So: every confident read becomes a room, keyed and labelled by the number
    that is printed in it and positioned at the pocket's interior point. A
    traced room the scan never read is kept where it was, unless the scan
    positively contradicts it -- the pocket it sits in was read as some OTHER
    room -- in which case it is dropped and listed as displaced. A point the
    drawing says is somewhere else is worse than no point at all: it sends
    people to a specific wrong door, confidently.

    Then the decisions file: every `place` entry is put where the reviewer put
    it, as `scan-accepted` -- including over a confident read, because on WHERE
    a room is, a person looking at the plan outranks a text anchor. A room
    an editor accepted in the app keeps that source across a rebuild -- this
    used to reset every kept point to `traced`, which threw the decision away.

    Named spaces (the Cafeteria, the Black Box Theater) are never touched. They
    carry a name rather than a number and the reader does not read them.
    """
    decisions = decisions or {}
    for floor, r in report.items():
        path = os.path.join(plans.OUT_DIR, f'{floor}.json')
        d = json.load(open(path))
        pts = d['points']

        # Best read per number, across all three outcome buckets.
        best = {}
        contested = set()
        for entry in r['confirmed'] + r['corrected'] + r['found']:
            if entry['conf'] < min_conf:
                continue
            prev = best.get(entry['text'])
            if prev is None or entry['conf'] > prev['conf']:
                best[entry['text']] = entry
            # Every traced point sitting in a pocket the scan read is now
            # accounted for -- either it agreed, or the scan overruled it.
            for pid in entry['traced']:
                if pid != entry['text']:
                    contested.add(pid)

        places = {p['text']: p for p in decisions.get(floor, {}).get('place', [])}

        kept, replaced, displaced = [], [], []
        out = {}
        for pid, p in pts.items():
            if p.get('kind') != 'room':
                out[pid] = p
                continue
            # A named space, not a numbered room.
            if not ROOM_RE.match(pid):
                out[pid] = p
                continue
            if pid in places:
                continue  # re-added below, where the reviewer put it
            if pid in best:
                replaced.append(pid)
                continue  # re-added below, from the scan
            if pid in contested and p.get('source') != 'scan-accepted':
                displaced.append(pid)
                continue
            p = dict(p)
            if p.get('source') != 'scan-accepted':
                p['source'] = 'traced'
                p.pop('confidence', None)
            out[pid] = p
            kept.append(pid)

        for text, entry in sorted(best.items()):
            out[text] = {
                'x': entry['x'],
                'y': entry['y'],
                'kind': 'room',
                'label': text,
                'source': 'scan',
                'confidence': entry['conf'],
            }

        placed = []
        for text, p in sorted(places.items()):
            # A person who looked at the scan outranks the reader on WHERE a
            # room is, even one the reader also read: a word read in a leaky
            # pocket is anchored on its text, which can sit against a wall.
            out[text] = {'x': p['x'], 'y': p['y'], 'kind': 'room', 'label': text,
                         'source': 'scan-accepted'}
            placed.append(text)

        d['points'] = out
        # An edge naming a point that no longer exists would break the graph.
        gone = set(pts) - set(out)
        if gone:
            d['edges'] = [e for e in d['edges'] if e['a'] not in gone and e['b'] not in gone]
        with open(path, 'w') as fh:
            json.dump(d, fh, indent=1)
        r['applied'] = {'fromScan': sorted(best), 'keptTraced': kept,
                        'placed': placed, 'displaced': displaced}
        log(f'  {floor}: {len(best)} rooms from the scan, {len(placed)} placed by review, '
            f'{len(kept)} traced rooms kept, {len(displaced)} displaced')
        if displaced:
            log(f'    displaced (the scan reads a different number in their pocket): {displaced}')


def write_app_report(report):
    """A trimmed report the app can ship and show in Edit mode.

    Coordinates and numbers only -- nothing derived from the page pixels, so
    this is allowed under src/ where the scans themselves are not.
    """
    out = {}
    for floor, r in report.items():
        out[floor] = {
            'corrected': [
                {'was': e['was'], 'text': e['text'], 'x': e['x'], 'y': e['y'], 'conf': e['conf']}
                for e in r['corrected']
            ],
            'found': [
                {'text': e['text'], 'x': e['x'], 'y': e['y'], 'conf': e['conf']}
                for e in r['found']
            ],
            'unread': [{'label': e['label'], 'x': e['x'], 'y': e['y']} for e in r['unread']],
            'confirmed': len(r['confirmed']),
        }
    path = os.path.join(plans.OUT_DIR, 'scan-report.json')
    with open(path, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'))
    log(f'wrote {os.path.relpath(path, plans.ROOT)}')


if __name__ == '__main__':
    main(sys.argv[1:])
