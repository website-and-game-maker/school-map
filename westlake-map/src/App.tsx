import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import MapCanvas, { type EditTool } from "./components/MapCanvas";
// three.js is ~1.2 MB of the bundle, and most visits never open the 3D view.
// Loading it on demand keeps the 2D map — the thing a lost freshman needs in
// the next ten seconds — fast on school wifi.
const MapCanvas3D = lazy(() => import("./components/MapCanvas3D"));
import SearchBox from "./components/SearchBox";
import { FLOOR_ORDER, INITIAL_FLOORS, INITIAL_STAIRS } from "./data/floors";
import { route as computeRoute, clearRouteCache, type Endpoint } from "./lib/router";
import { buildDirections, FLOOR_LABELS, PX_PER_FOOT } from "./lib/directions";
import { buildSearchIndex, searchItems, type SearchItem } from "./lib/search";
import { linksFromMarks, stairMarks } from "./lib/stairsFromMarks";
import { downloadJson, saveFloorToDisk } from "./lib/save";
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
  // The 3D view is a second renderer of the state the 2D view already
  // computes — not a second feature. "All" only means something in 3D.
  const [view, setView] = useState<"2d" | "3d">("2d");

  const [fromQuery, setFromQuery] = useState("Chap Court Entrance (C)");
  const [toQuery, setToQuery] = useState("");
  const [fromItem, setFromItem] = useState<SearchItem | null>(null);
  const [toItem, setToItem] = useState<SearchItem | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [tool, setTool] = useState<EditTool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState("");
  const [sheetOpen, setSheetOpen] = useState(true);
  const [activeStep, setActiveStep] = useState<number | null>(null);

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

  function updateFloor(updater: (f: FloorData) => FloorData) {
    // Cached distance fields are keyed to point positions, so moving a stair
    // or a room invalidates them.
    clearRouteCache();
    setFloors((prev) => ({ ...prev, [floorId]: updater(prev[floorId]) }));
  }

  function onAddPoint(x: number, y: number) {
    const isStairs = tool === "add-stairs";
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

  async function handleSave() {
    setSaveStatus("Saving…");
    const ok = await saveFloorToDisk(floorId, floors[floorId]);
    if (ok) {
      setSaveStatus(`Saved to src/data/floors/${floorId}.json`);
    } else {
      setSaveStatus("Dev server not reachable — downloaded the file instead");
      downloadJson(`${floorId}.json`, floors[floorId]);
    }
    window.setTimeout(() => setSaveStatus(""), 4000);
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

      {/* A view mode for the whole app, so it sits above the search fields.
          White thumb, not the maroon fill: maroon in this app means "the
          subject you selected" — a floor, a leg — and a view mode isn't one. */}
      <div className="view-toggle">
        <button
          className={view === "2d" ? "active" : ""}
          onClick={() => setView("2d")}
        >
          2D Plan
        </button>
        <button
          className={view === "3d" ? "active" : ""}
          onClick={() => {
            setEditMode(false);
            setView("3d");
          }}
        >
          3D View
        </button>
      </div>

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

      {view === "2d" && (
      <div className="field edit-toggle-row">
        <button
          className={`edit-toggle${editMode ? " on" : ""}`}
          onClick={() => {
            setEditMode((v) => !v);
            setSelectedId(null);
            setTool("select");
          }}
        >
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

          <div className="save-row">
            <button className="save-btn" onClick={handleSave}>
              Save {FLOOR_LABELS[floorId]}
            </button>
            <button
              className="download-btn"
              onClick={() => downloadJson(`${floorId}.json`, floors[floorId])}
            >
              Download JSON
            </button>
          </div>
          {saveStatus && <p className="save-status">{saveStatus}</p>}
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
            <li>Photo walkthroughs, live hallway traffic, class/teacher search.</li>
          </ul>
          <p className="disclaimer">
            Positions were traced by eye from the official floor plan, and distances are estimates.
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
          panning={{ disabled: editMode }}
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
            route={routeResult}
            routeKey={`${fromItem?.kind ?? ""}:${fromItem?.floor ?? ""}:${fromItem?.id ?? ""}|${toItem?.kind ?? ""}:${toItem?.floor ?? ""}:${toItem?.id ?? ""}|${legs.length}`}
            directions={directions}
            activeStep={activeStep}
            onPickFloor={switchFloor}
            onFatal={() => setView("2d")}
          />
          </Suspense>
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
