import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import MapCanvas, { type EditTool } from "./components/MapCanvas";
// three.js is ~1.2 MB of the bundle, and most visits never open the 3D view.
// Loading it on demand keeps the 2D map — the thing a lost freshman needs in
// the next ten seconds — fast on school wifi.
const MapCanvas3D = lazy(() => import("./components/MapCanvas3D"));
import SearchBox from "./components/SearchBox";
import DimensionSlider from "./components/DimensionSlider";
import EditorKeyDialog from "./components/EditorKeyDialog";
import FeedbackPanel from "./components/FeedbackPanel";
import { FLOOR_ORDER, INITIAL_FLOORS, INITIAL_STAIRS } from "./data/floors";
import { route as computeRoute, clearRouteCache, type Endpoint } from "./lib/router";
import { buildDirections, FLOOR_LABELS, PX_PER_FOOT } from "./lib/directions";
import { buildSearchIndex, searchItems, type SearchItem } from "./lib/search";
import { linksFromMarks, stairMarks } from "./lib/stairsFromMarks";
import { downloadJson, saveFloorToDisk } from "./lib/save";
import { EDITING_CONFIGURED, forgetEditor, resolveEditAccess } from "./lib/access";
import {
  NUDGE,
  REFERENCE_FLOOR,
  describe as describeAlignment,
  forFile as alignmentForFile,
  initialPlacements,
  isDirty as alignmentDirty,
  markVerified,
  nudge as nudgeAlignment,
} from "./lib/alignment";
import { buildProposal, downloadProposal } from "./lib/proposal";
import { reviewFor } from "./lib/scanReview";
import type { FloorData, FloorId, FloorPoint } from "./types";
import "./App.css";

const FLOOR_SHORT: Record<FloorId, string> = { lower: "Lower", main: "Main", upper: "Upper" };

export default function App() {
  const [floors, setFloors] = useState<Record<FloorId, FloorData>>(INITIAL_FLOORS);
  // Stair links: the guessed ones from stairs.json, plus any the user has
  // marked in Edit mode (those get matched across floors automatically and
  // count as verified).
  const markedStairs = useMemo(() => linksFromMarks(floors), [floors]);
  const stairs = useMemo(() => [...markedStairs, ...INITIAL_STAIRS], [markedStairs]);
  const markCount = useMemo(() => stairMarks(floors).length, [floors]);
  const [floorId, setFloorId] = useState<FloorId>("main");

  // How much 3D, 0..1. See three/units.ts. This is one dial, not two view
  // modes: the 2D renderer is what the flat end of it looks like, and the app
  // swaps to it there because that end is also where editing happens.
  //
  // It starts at BUILDING, so the first thing anyone sees is the building. A
  // flat plan of a three-storey school does not tell you it has three storeys,
  // and that is the single most common thing people get wrong about this place.
  const [dimension, setDimension] = useState(0.5);
  const [showStairColumns, setShowStairColumns] = useState(true);
  const [placements, setPlacements] = useState(initialPlacements);
  const view: "2d" | "3d" = dimension <= 0.001 ? "2d" : "3d";

  const [fromQuery, setFromQuery] = useState("Chap Court Entrance (C)");
  const [toQuery, setToQuery] = useState("");
  const [fromItem, setFromItem] = useState<SearchItem | null>(null);
  const [toItem, setToItem] = useState<SearchItem | null>(null);

  const [editMode, setEditMode] = useState(false);
  // Editing happens on the flat plan: the SVG overlay that carries the points,
  // the drag handles and the click targets is a 2D thing. Turning editing on
  // therefore runs the dial down to 0 rather than refusing the two to coexist.
  const [dimensionBeforeEdit, setDimensionBeforeEdit] = useState(0.5);
  // Null until the check resolves, so the editing tools never flash up for a
  // visitor while an async check is still in flight.
  const [canEdit, setCanEdit] = useState<boolean | null>(null);
  const [tool, setTool] = useState<EditTool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState("");
  const [sheetOpen, setSheetOpen] = useState(true);
  const [activeStep, setActiveStep] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    resolveEditAccess().then((ok) => {
      if (live) setCanEdit(ok);
    });
    return () => {
      live = false;
    };
  }, []);

  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const mapAreaRef = useRef<HTMLDivElement | null>(null);

  const floor = floors[floorId];
  const searchIndex = useMemo(() => buildSearchIndex(floors), [floors]);
  const restroomCount = useMemo(
    () => searchIndex.filter((i) => i.kind === "restroom").length,
    [searchIndex]
  );

  // Default start: the Chap Court entrance, because the tour map marks it as
  // the visitor entrance with the check-in desk — which is where someone who
  // needs this app is most likely to be standing. Resolved out of the real
  // index so it behaves exactly like anything the user picks themselves.
  useEffect(() => {
    if (fromItem) return;
    const c = searchIndex.find(
      (i) => i.kind === "entrance" && i.label.startsWith("Chap Court")
    );
    if (c) setFromItem(c);
  }, [searchIndex, fromItem]);

  const fromResults = useMemo(
    () => (fromItem && fromQuery === fromItem.label ? [] : searchItems(searchIndex, fromQuery)),
    [searchIndex, fromQuery, fromItem]
  );
  const toResults = useMemo(
    () =>
      toItem && toQuery === toItem.label
        ? []
        : searchItems(searchIndex, toQuery, { hasRestrooms: restroomCount > 0 }),
    [searchIndex, toQuery, toItem, restroomCount]
  );

  // An entrance letter exists on several floors under the same point id, and
  // "nearest restroom" is whichever one is genuinely closest — so each end of
  // a route can offer several candidate points and let the search decide.
  const endpointsFor = useCallback(
    (item: SearchItem | null): Endpoint[] => {
      if (!item) return [];
      const at = (floor: FloorId, id: string): Endpoint | null => {
        const p = floors[floor].points[id];
        return p ? { floor, x: p.x, y: p.y } : null;
      };
      if (item.kind === "nearest-restroom") {
        return searchIndex
          .filter((i) => i.kind === "restroom")
          .map((i) => at(i.floor, i.id))
          .filter(Boolean) as Endpoint[];
      }
      if (item.kind === "entrance") {
        return FLOOR_ORDER.map((f) => at(f, item.id)).filter(Boolean) as Endpoint[];
      }
      const one = at(item.floor, item.id);
      return one ? [one] : [];
    },
    [floors, searchIndex]
  );

  const routeResult = useMemo(() => {
    if (editMode) return null;
    const starts = endpointsFor(fromItem);
    const ends = endpointsFor(toItem);
    if (starts.length === 0 || ends.length === 0) return null;
    return computeRoute(floors, stairs, starts, ends, PX_PER_FOOT);
  }, [floors, stairs, fromItem, toItem, endpointsFor, editMode]);

  const legs = useMemo(() => routeResult?.legs ?? [], [routeResult]);
  const segments = legs;
  const [segIndex, setSegIndex] = useState(0);

  const directions = useMemo(() => {
    if (!routeResult || legs.length === 0 || !fromItem || !toItem) return null;
    const startLabel = fromItem.kind === "room" ? `Room ${fromItem.label}` : fromItem.label;
    const endLabel =
      toItem.kind === "room"
        ? `Room ${toItem.label}`
        : toItem.kind === "nearest-restroom"
          ? "The nearest restroom"
          : toItem.label;
    return buildDirections(legs, startLabel, endLabel);
  }, [routeResult, legs, fromItem, toItem]);

  const currentLeg = legs[segIndex] ?? null;
  const isFirstLeg = segIndex === 0;
  const isFinalLeg = segIndex === legs.length - 1;

  // ---------------- map framing ----------------

  const frameOn = useCallback(
    (box: { minX: number; minY: number; maxX: number; maxY: number }, animate = 420) => {
      const area = mapAreaRef.current;
      const tp = transformRef.current;
      if (!area || !tp) return;
      const isPhone = window.innerWidth <= 760;
      const padX = 60;
      const padTop = 60;
      // On a phone the bottom sheet covers the lower part of the map, so aim
      // the route at the strip that's actually visible.
      const padBottom = isPhone ? (sheetOpen ? area.clientHeight * 0.52 : 200) : 60;
      const w = Math.max(box.maxX - box.minX, 200);
      const h = Math.max(box.maxY - box.minY, 200);
      const availW = Math.max(area.clientWidth - padX * 2, 100);
      const availH = Math.max(area.clientHeight - padTop - padBottom, 100);
      const scale = Math.min(Math.min(availW / w, availH / h), 1.1);
      const cx = (box.minX + box.maxX) / 2;
      const cy = (box.minY + box.maxY) / 2;
      const targetX = area.clientWidth / 2;
      const targetY = padTop + availH / 2;
      tp.setTransform(targetX - cx * scale, targetY - cy * scale, scale, animate);
    },
    [sheetOpen]
  );

  const frameLeg = useCallback(
    (leg: { path: [number, number][] } | null) => {
      if (!leg || leg.path.length === 0) return;
      const xs = leg.path.map((p) => p[0]);
      const ys = leg.path.map((p) => p[1]);
      frameOn({
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      });
    },
    [frameOn]
  );

  // New route: jump to its first floor and frame it.
  useEffect(() => {
    setSegIndex(0);
    setActiveStep(null);
    if (segments.length > 0) setFloorId(segments[0].floor);
  }, [routeResult]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (view !== "2d") return; // in 3D the viewer owns the camera
    frameLeg(legs[segIndex] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segIndex, legs, view]);

  function goToSegment(i: number) {
    const seg = segments[i];
    if (!seg) return;
    setSegIndex(i);
    setFloorId(seg.floor);
    setActiveStep(null);
  }

  function switchFloor(f: FloorId) {
    setFloorId(f);
    const i = segments.findIndex((s) => s.floor === f);
    if (i >= 0) setSegIndex(i);
  }

  function focusStep(i: number) {
    const step = directions?.steps[i];
    if (!step) return;
    setActiveStep(i);
    if (step.legIndex !== segIndex) {
      setSegIndex(step.legIndex);
      setFloorId(step.floor);
    }
    if (step.at && view === "2d") {
      const [x, y] = step.at;
      frameOn({ minX: x - 320, maxX: x + 320, minY: y - 320, maxY: y + 320 });
    }
  }

  function swapEnds() {
    const f = fromItem;
    const t = toItem;
    if (t && t.kind === "nearest-restroom") return; // "nearest restroom" isn't a start
    setFromItem(t);
    setToItem(f);
    setFromQuery(t?.label ?? "");
    setToQuery(f?.label ?? "");
  }

  function clearRoute() {
    setToItem(null);
    setToQuery("");
    setActiveStep(null);
  }

  function floorTagFor(item: SearchItem): string | null {
    if (item.kind === "entrance" || item.kind === "nearest-restroom") return null;
    return FLOOR_SHORT[item.floor];
  }

  // ---------------- edit mode ----------------

  function toggleEditMode() {
    setEditMode((on) => {
      if (!on) {
        setDimensionBeforeEdit(dimension);
        setDimension(0);
      } else {
        setDimension(dimensionBeforeEdit);
      }
      return !on;
    });
    setSelectedId(null);
    setTool("select");
  }

  function updateFloor(updater: (f: FloorData) => FloorData) {
    // Cached distance fields are keyed to point positions, so moving a stair
    // or a room invalidates them.
    clearRouteCache();
    setFloors((prev) => ({ ...prev, [floorId]: updater(prev[floorId]) }));
  }

  /**
   * How close two stair markers on the SAME floor have to be before the second
   * one is treated as a correction of the first rather than a new stairwell.
   * Generous, because the point of the rule is that a stairwell gets exactly
   * one marker per floor — two markers 30 ft apart on Main cannot both be the
   * bottom of the same flight, and if they are both kept the cross-floor
   * matching has to guess which one Upper's marker pairs with.
   */
  const SAME_STAIR_PX = 150;

  function onAddPoint(x: number, y: number) {
    const isStairs = tool === "add-stairs";

    // One point per stairwell per floor. Clicking again nearby moves the marker
    // you already placed instead of adding a rival to it, so "which stairwell
    // is this" always has one answer and the column drawn through the storeys
    // is unambiguous.
    if (isStairs) {
      const existing = Object.entries(floor.points).find(
        ([, p]) =>
          p.kind === "poi" && p.poiType === "stairs" && Math.hypot(p.x - x, p.y - y) < SAME_STAIR_PX
      );
      if (existing) {
        onMovePoint(existing[0], x, y);
        setSelectedId(existing[0]);
        return;
      }
    }

    const id = `${isStairs ? "stairs" : "wc"}-${Date.now()}`;
    const point: FloorPoint = {
      x: Math.round(x),
      y: Math.round(y),
      kind: "poi",
      poiType: isStairs ? "stairs" : "restroom",
      label: isStairs ? "Stairs" : "Restroom",
    };
    updateFloor((f) => ({ ...f, points: { ...f.points, [id]: point } }));
    setSelectedId(id);
  }

  function onMovePoint(id: string, x: number, y: number) {
    updateFloor((f) => ({
      ...f,
      points: { ...f.points, [id]: { ...f.points[id], x: Math.round(x), y: Math.round(y) } },
    }));
  }

  function deleteSelected() {
    if (!selectedId) return;
    const id = selectedId;
    updateFloor((f) => {
      const points = { ...f.points };
      delete points[id];
      return { ...f, points, edges: f.edges.filter((e) => e.a !== id && e.b !== id) };
    });
    setSelectedId(null);
  }

  function updateSelectedLabel(label: string) {
    if (!selectedId) return;
    updateFloor((f) => ({
      ...f,
      points: { ...f.points, [selectedId]: { ...f.points[selectedId], label } },
    }));
  }

  /**
   * Editing never writes to the live map. Against `npm run dev` it writes the
   * tracked JSON, because that is a maintainer editing their own checkout. On
   * the published site there is nothing to write to, so the edit leaves as a
   * proposal for somebody with repository access to review and merge.
   */
  async function handleSave() {
    const base = INITIAL_FLOORS[floorId];
    const proposal = buildProposal(floorId, base, floors[floorId]);
    if (import.meta.env.DEV) {
      setSaveStatus("Saving…");
      const ok = await saveFloorToDisk(floorId, floors[floorId]);
      setSaveStatus(
        ok
          ? `Written to src/data/floors/${floorId}.json — still needs committing`
          : "Dev server not reachable — downloaded a proposal instead"
      );
      if (!ok) downloadProposal(proposal);
    } else {
      downloadProposal(proposal);
      setSaveStatus(
        `Proposal downloaded — ${proposal.summary.length} change(s). Nothing is live until it is reviewed.`
      );
    }
    window.setTimeout(() => setSaveStatus(""), 6000);
  }

  // ---------------- what the scan reader is unsure about ----------------

  const review = useMemo(() => reviewFor(floorId, floor), [floorId, floor]);

  /** Accept one of the reader's low-confidence reads as a real room. */
  function acceptSuggestion(s: { text: string; x: number; y: number; conf: number }) {
    updateFloor((f) => ({
      ...f,
      points: {
        ...f.points,
        [s.text]: {
          x: s.x,
          y: s.y,
          kind: "room",
          label: s.text,
          // Recorded as a human decision, not as something the scan established
          // on its own — the whole reason this room is in the queue is that the
          // reader was not sure.
          source: "scan-accepted",
          confidence: s.conf,
        },
      },
    }));
    setSelectedId(s.text);
    frameOn({ minX: s.x - 260, maxX: s.x + 260, minY: s.y - 260, maxY: s.y + 260 });
  }

  // ---------------- floor alignment ----------------

  const canAlign = floorId !== REFERENCE_FLOOR;
  const alignDirty = useMemo(() => alignmentDirty(placements), [placements]);

  function bump(change: Parameters<typeof nudgeAlignment>[2]) {
    setPlacements((prev) => nudgeAlignment(prev, floorId, change));
  }

  function resetAlignment() {
    setPlacements(initialPlacements());
  }

  function proposeAlignment() {
    const payload = {
      kind: "westlake-map-alignment-proposal",
      version: 1,
      summary: describeAlignment(placements),
      data: alignmentForFile(placements),
    };
    if (import.meta.env.DEV) {
      setSaveStatus("Saving alignment…");
      void saveFloorToDisk("align3d", payload.data).then((ok) => {
        setSaveStatus(
          ok
            ? "Written to src/data/floors/align3d.json — still needs committing"
            : "Dev server not reachable — downloaded the alignment instead"
        );
        if (!ok) downloadJson("proposal-align3d.json", payload);
        window.setTimeout(() => setSaveStatus(""), 6000);
      });
      return;
    }
    downloadJson("proposal-align3d.json", payload);
    setSaveStatus(`Alignment proposal downloaded — ${payload.summary.length} change(s).`);
    window.setTimeout(() => setSaveStatus(""), 6000);
  }

  const selectedPoint = selectedId ? floor.points[selectedId] : null;
  const destLabel = toItem ? toItem.label : "";
  const routeMissing = Boolean(fromItem && toItem && !routeResult);

  const panel = (
    <>
      <div className="brand">
        <span className="brand-mark">W</span>
        <div>
          <h1>Westlake Map</h1>
          <p className="subtitle">Find your way. Home of the Chaps.</p>
        </div>
      </div>

      {/* One dial from a flat plan to an exploded stack, instead of two view
          modes. The interesting positions are the ones in between. */}
      <DimensionSlider value={dimension} onChange={setDimension} disabled={editMode} />

      {!editMode && (
        <>
          <div className="trip">
            <SearchBox
              label="From"
              placeholder="Room, entrance, or place"
              value={fromQuery}
              results={fromResults}
              floorLabel={floorTagFor}
              onQueryChange={(q) => {
                setFromQuery(q);
                setFromItem(null);
              }}
              onPick={(item) => {
                setFromItem(item);
                setFromQuery(item.label);
              }}
              onClear={() => {
                setFromQuery("");
                setFromItem(null);
              }}
            />
            <button
              className="swap-btn"
              onClick={swapEnds}
              disabled={!fromItem && !toItem}
              title="Swap start and destination"
              aria-label="Swap start and destination"
            >
              ⇅
            </button>
            <SearchBox
              label="To"
              placeholder='e.g. 245, Library, "restroom"'
              value={toQuery}
              results={toResults}
              floorLabel={floorTagFor}
              onQueryChange={(q) => {
                setToQuery(q);
                setToItem(null);
              }}
              onPick={(item) => {
                setToItem(item);
                setToQuery(item.label);
              }}
              onClear={clearRoute}
            />
          </div>

          {!toItem && (
            <div className="quick-row">
              <span className="quick-label">Popular</span>
              {["Library", "Cafeteria", "Commons", "Auditorium"].map((name) => {
                const item = searchIndex.find((i) => i.label === name);
                if (!item) return null;
                return (
                  <button
                    key={name}
                    className="quick-chip"
                    onClick={() => {
                      setToItem(item);
                      setToQuery(item.label);
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          )}

          {routeMissing && (
            <p className="notice">
              I know where <strong>{toItem?.label}</strong> is, but no traced hallway reaches it yet,
              so there's nothing to route along. <strong>Edit this floor</strong> below — drop a
              couple of hallway points and connect them — and the route will appear.
            </p>
          )}

          {directions && routeResult && (
            <div className="route-summary">
              <div className="route-headline">
                <span className="route-time">≈ {directions.minutes} min</span>
                <span className="route-dist">{directions.totalFeet} ft</span>
                {directions.flights > 0 && (
                  <span className="route-flights">
                    {directions.flights} stair{directions.flights > 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {segments.length > 1 && (
                <div className="route-path">
                  {segments.map((s, i) => (
                    <span key={i}>
                      {i > 0 && <span className="route-arrow">→</span>}
                      <button
                        className={`seg-chip${i === segIndex ? " active" : ""}`}
                        onClick={() => goToSegment(i)}
                      >
                        {FLOOR_SHORT[s.floor]}
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <ol className="steps">
                {directions.steps.map((step, i) => (
                  <li key={i} className={`step step-${step.kind}${activeStep === i ? " active" : ""}`}>
                    <button onClick={() => focusStep(i)}>
                      <span className="step-icon" aria-hidden="true">
                        {step.kind === "start" ? "◉" : step.kind === "stairs" ? "⇅" : step.kind === "arrive" ? "◆" : "↑"}
                      </span>
                      <span className="step-text">{step.text}</span>
                    </button>
                  </li>
                ))}
              </ol>

              {routeResult.stairs.length > 0 && (
                <p className="hint">
                  Stair locations are still a best guess — see the note at the bottom.
                </p>
              )}
              <button className="clear-btn" onClick={clearRoute}>
                Clear route
              </button>
            </div>
          )}
        </>
      )}

      <div className="field">
        <label>Floor</label>
        <div className="floor-tabs">
          {FLOOR_ORDER.map((f) => (
            <button
              key={f}
              className={`floor-tab${floorId === f ? " active" : ""}`}
              onClick={() => switchFloor(f)}
            >
              {FLOOR_LABELS[f].replace(" Level", "")}
              {segments.some((s) => s.floor === f) && <span className="route-dot" />}
            </button>
          ))}
        </div>
      </div>

      {canEdit && (
        <div className="field edit-toggle-row">
          <button className={`edit-toggle${editMode ? " on" : ""}`} onClick={toggleEditMode}>
            {editMode ? "Done editing" : "✎ Edit this floor"}
          </button>
        </div>
      )}

      {editMode && (
        <div className="edit-panel">
          <p className="hint">
            Editing <strong>{FLOOR_LABELS[floorId]}</strong>. Routes follow the walls traced from the
            plan itself, so hallways don't need drawing — what's still worth marking is stairs and
            restrooms, which the plan doesn't label.
          </p>
          <div className="tool-row">
            <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}>
              Move
            </button>
            <button
              className={tool === "add-stairs" ? "active" : ""}
              onClick={() => setTool("add-stairs")}
            >
              + Stairs
            </button>
            <button
              className={tool === "add-restroom" ? "active" : ""}
              onClick={() => setTool("add-restroom")}
            >
              + Restroom
            </button>
          </div>
          <p className="tool-hint">
            {tool === "select" && "Click a point to select it, drag to move it."}
            {tool === "add-stairs" &&
              "Click a stairwell. Mark the same one on each floor it serves and they're linked automatically — that's what replaces the guessed stair links."}
            {tool === "add-restroom" && "Click anywhere on the map to mark a restroom."}
          </p>
          <p className="tool-hint">
            {markCount === 0
              ? "No stairs marked yet — routes between floors are using guesses."
              : `${markCount} stair marker${markCount === 1 ? "" : "s"} placed, forming ${markedStairs.length} linked stairwell${markedStairs.length === 1 ? "" : "s"}.`}
          </p>

          {selectedPoint && (
            <div className="inspector">
              <p className="inspector-title">
                {selectedId} <span className="kind-tag">{selectedPoint.kind}</span>
              </p>
              {selectedPoint.kind === "poi" && (
                <input
                  value={selectedPoint.label ?? ""}
                  placeholder="Label (optional)"
                  onChange={(e) => updateSelectedLabel(e.target.value)}
                />
              )}
              <button className="danger-btn" onClick={deleteSelected}>
                Delete point
              </button>
            </div>
          )}

          {/* ---- what the scan reader could not settle ---- */}
          {(review.suggestions.length > 0 || review.missing.length > 0) && (
            <div className="review-panel">
              <p className="align-title">The scan isn't sure about these</p>
              <p className="tool-hint">
                <code>tools/read_plan.py</code> read the room numbers straight off the plan and
                applied the {review.confirmed} it was confident about on this floor. These it saw
                but couldn't settle. Accepting one drops a room at the spot the scan points to.
              </p>
              {review.suggestions.map((s) => (
                <div key={s.text} className="review-row">
                  <div>
                    <strong>{s.text}</strong>
                    <span className="review-conf">{Math.round(s.conf * 100)}% sure</span>
                    {s.was && s.was.length > 0 && (
                      <span className="review-was">was traced as {s.was.join("/")}</span>
                    )}
                  </div>
                  <button onClick={() => acceptSuggestion(s)}>Place it</button>
                </div>
              ))}
              {review.missing.length > 0 && (
                <p className="tool-hint">
                  No reading at all for{" "}
                  <strong>{review.missing.join(", ")}</strong>. Their old positions were inside
                  rooms the plan prints a different number in, so they were removed rather than
                  left sending people to the wrong door. Drop them in by hand if you know where
                  they are.
                </p>
              )}
            </div>
          )}

          {/* ---- how the floors stack ---- */}
          <div className="align-panel">
            <p className="align-title">How the floors line up</p>
            <p className="tool-hint">
              The three plans are separate scans with no registration marks, so where a storey sits
              relative to the others is a fit through a handful of shared entrances — out by
              anywhere from 10 to 51 ft. Slide the 3D dial up to <strong>Exploded</strong> and watch
              the coloured stairwell columns: where two floors are misaligned, the column joining
              them <em>leans</em>. Nudge until it stands up.
            </p>
            <label className="align-check">
              <input
                type="checkbox"
                checked={showStairColumns}
                onChange={(e) => setShowStairColumns(e.target.checked)}
              />
              Show stairwell columns
            </label>

            {canAlign ? (
              <>
                <div className="align-grid">
                  <button onClick={() => bump({ ty: -NUDGE.coarse })} title="North, 25 px">↑↑</button>
                  <button onClick={() => bump({ ty: -NUDGE.fine })} title="North, 4 px">↑</button>
                  <button onClick={() => bump({ ty: NUDGE.fine })} title="South, 4 px">↓</button>
                  <button onClick={() => bump({ ty: NUDGE.coarse })} title="South, 25 px">↓↓</button>
                  <button onClick={() => bump({ tx: -NUDGE.coarse })} title="West, 25 px">←←</button>
                  <button onClick={() => bump({ tx: -NUDGE.fine })} title="West, 4 px">←</button>
                  <button onClick={() => bump({ tx: NUDGE.fine })} title="East, 4 px">→</button>
                  <button onClick={() => bump({ tx: NUDGE.coarse })} title="East, 25 px">→→</button>
                  <button onClick={() => bump({ scale: -NUDGE.scale })} title="Shrink this storey">−%</button>
                  <button onClick={() => bump({ scale: NUDGE.scale })} title="Grow this storey">+%</button>
                  <button onClick={() => bump({ rotationDeg: -NUDGE.rotation })} title="Rotate anticlockwise">↺</button>
                  <button onClick={() => bump({ rotationDeg: NUDGE.rotation })} title="Rotate clockwise">↻</button>
                </div>
                <p className="align-readout">
                  {FLOOR_LABELS[floorId]}: offset {Math.round(placements[floorId].tx)},
                  {Math.round(placements[floorId].ty)} px · scale{" "}
                  {placements[floorId].scale.toFixed(4)} · {placements[floorId].rotationDeg.toFixed(2)}°
                  {placements[floorId].verified ? " · verified" : " · not verified"}
                </p>
                <label className="align-check">
                  <input
                    type="checkbox"
                    checked={placements[floorId].verified}
                    onChange={(e) => setPlacements((p) => markVerified(p, floorId, e.target.checked))}
                  />
                  I have checked this storey against the one below by eye
                </label>
                <div className="save-row">
                  <button className="save-btn" disabled={!alignDirty} onClick={proposeAlignment}>
                    Propose alignment
                  </button>
                  <button className="download-btn" disabled={!alignDirty} onClick={resetAlignment}>
                    Reset
                  </button>
                </div>
              </>
            ) : (
              <p className="tool-hint">
                {FLOOR_LABELS[REFERENCE_FLOOR]} is the reference everything else was fitted
                against, so it does not move. Switch to the Lower or Upper level to nudge one.
              </p>
            )}
          </div>

          <p className="review-note">
            Changes are only in this browser. The published map changes when a
            reviewer merges them — nothing here affects what anyone else sees.
          </p>
          <div className="save-row">
            <button className="save-btn" onClick={handleSave}>
              Propose changes
            </button>
            <button
              className="download-btn"
              onClick={() => downloadJson(`${floorId}.json`, floors[floorId])}
            >
              Raw JSON
            </button>
          </div>
          {saveStatus && <p className="save-status">{saveStatus}</p>}

          <FeedbackPanel
            context={{
              floorId,
              floor,
              from: fromItem?.label ?? null,
              to: toItem?.label ?? null,
              selectedId,
              lookingAt: selectedPoint ? [selectedPoint.x, selectedPoint.y] : null,
              view,
            }}
          />
        </div>
      )}

      {!editMode && (
        <div className="roadmap">
          <p className="roadmap-title">Still rough / coming later</p>
          <ul>
            <li>
              Stairwells aren't marked on the plan, and they're not something the scan can be read
              for — mark them in Edit mode and cross-floor routes become exact.
            </li>
            <li>Restrooms aren't on the plan either — mark those the same way.</li>
            <li>
              How the three floors line up is fitted from a handful of shared entrances and is out
              by 10–51 ft. Slide the dial to <strong>Exploded</strong> and the stairwell columns
              show you where: a column that leans is a floor that needs nudging.
            </li>
            <li>Photo walkthroughs, live hallway traffic, class/teacher search.</li>
          </ul>
          <p className="disclaimer">
            Most room positions are now read off the official floor plan by machine, number and
            all; the rest were traced by eye and are marked as such in the data. Distances are
            estimates from a single scale constant either way.
          </p>
        </div>
      )}
    </>
  );

  return (
    <div className={`app${editMode ? " editing" : ""}`}>
      <main className={`map-area${view === "3d" ? " map-area-3d" : ""}`} ref={mapAreaRef}>
        {view === "2d" ? (
        <TransformWrapper
          ref={transformRef}
          initialScale={0.35}
          minScale={0.12}
          maxScale={3}
          limitToBounds={false}
          doubleClick={{ disabled: editMode }}
          // Panning stays on in edit mode. It used to be switched off, which
          // meant that the moment you started editing the map froze in place —
          // you could not drag to see the part of the floor you wanted to fix.
          // Dragging a point still moves the point rather than the map, because
          // the point's own pointerdown stops the event before it gets here.
          panning={{ velocityDisabled: editMode }}
        >
          <TransformComponent wrapperClass="tp-wrapper" contentClass="tp-content">
            <MapCanvas
              floor={floor}
              editMode={editMode}
              tool={tool}
              selectedId={selectedId}
              onSelectPoint={setSelectedId}
              onAddPoint={onAddPoint}
              onMovePoint={onMovePoint}
              routeLine={editMode ? null : currentLeg?.path ?? null}
              startAt={!editMode && currentLeg ? currentLeg.path[0] : null}
              endAt={!editMode && currentLeg ? currentLeg.path[currentLeg.path.length - 1] : null}
              startLabel={
                !editMode && isFirstLeg && fromItem
                  ? fromItem.kind === "room"
                    ? `Room ${fromItem.label}`
                    : fromItem.label
                  : null
              }
              endLabel={
                !editMode && isFinalLeg && toItem
                  ? toItem.kind === "room"
                    ? `Room ${toItem.label}`
                    : toItem.label
                  : null
              }
              highlightAt={activeStep !== null ? directions?.steps[activeStep]?.at ?? null : null}
            />
          </TransformComponent>
        </TransformWrapper>
        ) : (
          <Suspense fallback={<div className="map-3d-loading">Building the model…</div>}>
          <MapCanvas3D
            floors={floors}
            stairs={stairs}
            activeFloor={floorId}
            dimension={dimension}
            showStairColumns={showStairColumns}
            placements={placements}
            route={routeResult}
            routeKey={`${fromItem?.kind ?? ""}:${fromItem?.floor ?? ""}:${fromItem?.id ?? ""}|${toItem?.kind ?? ""}:${toItem?.floor ?? ""}:${toItem?.id ?? ""}|${legs.length}`}
            directions={directions}
            activeStep={activeStep}
            onPickFloor={switchFloor}
            // Auto-focus: orbit onto a storey and it becomes the active floor,
            // so the panel, the badge and the model never disagree about which
            // one you are reading.
            onFocusFloor={setFloorId}
            onFatal={() => setDimension(0)}
          />
          </Suspense>
        )}

        {EDITING_CONFIGURED && (
          <div className="map-tools">
            <EditorKeyDialog
              unlocked={canEdit === true}
              onUnlock={() => setCanEdit(true)}
              onLock={() => {
                forgetEditor();
                setCanEdit(false);
                if (editMode) toggleEditMode();
              }}
            />
          </div>
        )}

        <div className="map-badge">
          {FLOOR_LABELS[floorId]}
          {destLabel && !editMode && <span className="map-badge-dest">→ {destLabel}</span>}
        </div>
      </main>

      {/* One panel: a sidebar on a laptop, a bottom sheet over the map on a
          phone. Same markup either way, so there's only ever one search box. */}
      <aside className={`panel-shell${sheetOpen ? " open" : ""}`}>
        <button
          className="sheet-handle"
          onClick={() => setSheetOpen((v) => !v)}
          aria-label={sheetOpen ? "Collapse panel" : "Expand panel"}
        >
          <span className="grabber" />
          <span className="sheet-peek">
            {directions ? `≈ ${directions.minutes} min · ${destLabel}` : "Search for a room or place"}
          </span>
        </button>
        <div className="panel-scroll">{panel}</div>
      </aside>
    </div>
  );
}
