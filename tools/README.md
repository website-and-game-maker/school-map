# Map data tooling

These regenerate the navigation data the app routes over. Run them from the
project root, with the plan pages rendered to `page0.png` (Main), `page1.png`
(Lower) and `page2.png` (Upper) alongside:

```
python3 tools/export_nav.py          # writes src/data/floors/nav-*.json
```

`mask4.py` does the hard part — turning a scanned plan into walkable space:

1. Threshold the ink, despeckle it, and clip to the building footprint (the ink
   is dilated until the outer wall closes, hole-filled, then shrunk back), so
   routes can't wander across the lawn.
2. Carve the doors. The plans draw doors *closed*: at full resolution not one
   classroom connects to the corridor, which is why routing used to fall back
   on straight lines. But a door is drawn as a notch in the wall, so the wall
   is measurably thinnest exactly where the door is — carving each enclosed
   room through its thinnest wall lands on the real doorway. Iterating catches
   rooms that open into other rooms.

`export_nav.py` then turns that into the grid the app searches:

- `walk` — standable cells
- `pub` — circulation space. Any pre-carve pocket containing a traced *room*
  label is a room; everything else (hallways, lobbies, the commons) is
  circulation, and routes prefer it.
- `east` / `south` — whether a step to that neighbour is legal, decided by the
  full-resolution pixels between the two cell centres. This is what makes walls
  real: judging cells alone lets a route slip through a wall that happens to
  fall between two open cells.
- finally, a pass that bridges any short gap left between the main network and
  a stranded pocket, so a room is never unroutable because the coarse grid
  refused the one step through its doorway.

Requires `numpy`, `scipy`, `pillow`.
