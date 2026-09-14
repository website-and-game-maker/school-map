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

import io
import json
import os
import re
import subprocess
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

import export_walls as ew
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


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------- ocr ----
def _png(im):
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


def _tesseract(arr, psm, scale, thicken):
    """One rendering of one crop. `arr` is a bool mask, True where there is ink."""
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
            input=_png(page), capture_output=True, timeout=30)
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


def read_pocket(pocket, ink):
    """Read the room number printed in one pocket. Returns (text, conf, centre)."""
    marks = marks_in_pocket(pocket, ink)
    if marks.sum() < MIN_MARK_PX:
        return '', 0.0, None
    crop, centre = glyph_crop(marks)
    if crop is None or crop.size == 0:
        return '', 0.0, None
    h, w = crop.shape
    if h > w * VERTICAL_ASPECT:
        # Set vertically. Which way up is not knowable from the crop, so read
        # both and let the grammar decide.
        options = [np.rot90(crop, -1), np.rot90(crop, 1)]
    else:
        options = [crop]
    best = ('', 0.0)
    for opt in options:
        text, conf = read_crop(opt)
        if (ROOM_RE.match(text) is not None, conf) > (ROOM_RE.match(best[0]) is not None, best[1]):
            best = (text, conf)
    return best[0], best[1], centre


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
    return ink, lab, n


def traced_rooms(floor):
    """The shipped room points, as {id: (x, y, label)}."""
    path = os.path.join(plans.OUT_DIR, f'{floor}.json')
    d = json.load(open(path))
    return {pid: p for pid, p in d['points'].items() if p.get('kind') == 'room'}


def read_floor(floor, render=False):
    log(f'{floor}: reading {os.path.relpath(plans.page_path(floor), plans.ROOT)}')
    ink, lab, n = storey_pockets(floor)
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

    digits = FLOOR_DIGITS[floor]
    reads = []
    for comp in range(1, n + 1):
        area = int(sizes[comp - 1])
        if not (MIN_POCKET_PX <= area <= MAX_POCKET_PX):
            continue
        sl = objs[comp - 1]
        if sl is None:
            continue
        pad = (slice(max(0, sl[0].start - 3), sl[0].stop + 3),
               slice(max(0, sl[1].start - 3), sl[1].stop + 3))
        pocket = (lab[pad] == comp)
        text, conf, _ = read_pocket(pocket, ink[pad])
        cy, cx, clear = pole_of_inaccessibility(pocket)
        entry = {
            'comp': comp,
            'area': area,
            'x': int(round(cx + pad[1].start)),
            'y': int(round(cy + pad[0].start)),
            'clearance': round(clear, 1),
            'text': text,
            'conf': round(conf, 3),
            'traced': owner.get(comp, []),
        }
        # A read is only a room number if it fits the grammar AND starts with a
        # digit this storey actually uses. "283" read off the Upper sheet is a
        # misread, not a room on the wrong floor -- the numbering is by storey.
        entry['valid'] = bool(ROOM_RE.match(text)) and text[0] in digits
        reads.append(entry)

    if render:
        _render(floor, reads)
    return reads


def _render(floor, reads):
    """A contact sheet of every read, for eyeballing what the reader saw."""
    out = os.path.join(plans.ASSETS, f'read-{floor}.png')
    grey = np.array(Image.open(plans.page_path(floor)).convert('RGB'))
    im = Image.fromarray(grey)
    from PIL import ImageDraw
    d = ImageDraw.Draw(im)
    for r in reads:
        colour = (0, 150, 0) if r['valid'] else (200, 0, 0)
        d.ellipse([r['x'] - 9, r['y'] - 9, r['x'] + 9, r['y'] + 9], outline=colour, width=3)
        if r['text']:
            d.text((r['x'] + 12, r['y'] - 8), f"{r['text']} {r['conf']:.2f}", fill=colour)
    im.save(out)
    log(f'  wrote {out}')


# --------------------------------------------------------------- reports ----
def reconcile(floor, reads):
    """Match what was read against what is shipped, and classify every room."""
    traced = traced_rooms(floor)
    by_label = {}
    for pid, p in traced.items():
        by_label.setdefault(p.get('label') or pid, []).append(pid)

    confirmed, corrected, found, unread = [], [], [], []
    seen = set()
    for r in reads:
        if not r['valid']:
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
            'found': found, 'unread': unread}


def main(argv):
    apply_changes = '--apply' in argv
    render = '--render' in argv
    min_conf = MIN_APPLY_CONF
    for a in argv:
        if a.startswith('--min-conf='):
            min_conf = float(a.split('=', 1)[1])
    floors = [a for a in argv if a in plans.FLOORS] or list(plans.FLOORS)

    report = {}
    for floor in floors:
        reads = read_floor(floor, render=render)
        r = reconcile(floor, reads)
        report[floor] = r
        valid = [x for x in reads if x['valid']]
        log(f'  {floor}: {len(reads)} pockets examined, {len(valid)} room numbers read')
        log(f'    confirmed {len(r["confirmed"])}  corrected {len(r["corrected"])}  '
            f'new {len(r["found"])}  unread {len(r["unread"])}')
        for c in r['corrected']:
            log(f'      traced {"/".join(c["was"])} -> scan reads {c["text"]} '
                f'(conf {c["conf"]:.2f}) at {c["x"]},{c["y"]}')
        if r['found']:
            log('      new: ' + ', '.join(f'{f["text"]}@{f["x"]},{f["y"]}' for f in r['found']))

    path = os.path.join(plans.ASSETS, 'read-report.json')
    with open(path, 'w') as fh:
        json.dump(report, fh, indent=1)
    log(f'wrote {os.path.relpath(path, plans.ROOT)}')

    write_app_report(report)
    if apply_changes:
        apply_report(report, min_conf)


def apply_report(report, min_conf=MIN_APPLY_CONF):
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

    Named spaces (the Cafeteria, the Black Box Theater) are never touched. They
    carry a name rather than a number and the reader does not read them.
    """
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
            if pid in best:
                replaced.append(pid)
                continue  # re-added below, from the scan
            if pid in contested:
                displaced.append(pid)
                continue
            p = dict(p)
            p['source'] = 'traced'
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

        d['points'] = out
        # An edge naming a point that no longer exists would break the graph.
        gone = set(pts) - set(out)
        if gone:
            d['edges'] = [e for e in d['edges'] if e['a'] not in gone and e['b'] not in gone]
        with open(path, 'w') as fh:
            json.dump(d, fh, indent=1)
        r['applied'] = {'fromScan': sorted(best), 'keptTraced': kept, 'displaced': displaced}
        log(f'  {floor}: {len(best)} rooms from the scan, {len(kept)} traced rooms kept, '
            f'{len(displaced)} displaced')
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
