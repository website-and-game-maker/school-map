import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import MapCanvas, { type EditTool } from "./components/MapCanvas";
import SearchBox from "./components/SearchBox";
import { FLOOR_IMAGES, FLOOR_ORDER, INITIAL_FLOORS, INITIAL_STAIRS } from "./data/floors";
import { buildAdjacency, nodeKey, shortestPathMulti, splitByFloor } from "./lib/pathfind";
import { buildWalkGrid, wallAwarePath, type WalkGrid } from "./lib/navmesh";
import { walkMasks } from "./lib/walkable";
import { buildDirections, FLOOR_LABELS, pointLabel, type RouteLeg } from "./lib/directions";
import { buildSearchIndex, searchItems, type SearchItem } from "./lib/search";
import { downloadJson, saveFloorToDisk } from "./lib/save";
import type { FloorData, FloorId, FloorPoint } from "./types";
import "./App.css";

const FLOOR_SHORT: Record<FloorId, string> = { lower: "Lower", main: "Main", upper: "Upper" };

export default function App() {
  const [floors, setFloors] = useState<Record<FloorId, FloorData>>(INITIAL_FLOORS);
  const [stairs] = useState(INITIAL_STAIRS);
  const [floorId, setFloorId] = useState<FloorId>("main");

  const [fromQuery, setFromQuery] = useState("Entrance C");
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
  const adjacency = useMemo(() => buildAdjacency(floors, stairs), [floors, stairs]);
  const searchIndex = useMemo(() => buildSearchIndex(floors), [floors]);
  const restroomCount = useMemo(
    () => searchIndex.filter((i) => i.kind === "restroom").length,
    [searchIndex]
  );

  // Default start: Entrance C, resolved out of the real index so it behaves
  // exactly like anything the user picks themselves.
  useEffect(() => {
    if (fromItem) return;
    const c = searchIndex.find((i) => i.kind === "entrance" && i.label === "Entrance C");
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

  // An entrance letter exists on several floors under the same point id, so a
  // route from/to one should be free to use whichever floor's copy is closest.
  const nodesFor = useCallback(
    (item: SearchItem | null): string[] => {
      if (!item) return [];
      if (item.kind === "nearest-restroom") {
        return searchIndex.filter((i) => i.kind === "restroom").map((i) => nodeKey(i.floor, i.id));
      }
      if (item.kind === "entrance") {
        return FLOOR_ORDER.filter((f) => floors[f].points[item.id]).map((f) => nodeKey(f, item.id));
      }
      return [nodeKey(item.floor, item.id)];
    },
    [floors, searchIndex]
  );

  const routeResult = useMemo(() => {
    const starts = nodesFor(fromItem);
    const ends = nodesFor(toItem);
    if (starts.length === 0 || ends.length === 0) return null;
    return shortestPathMulti(adjacency, starts, ends);
  }, [adjacency, fromItem, toItem, nodesFor]);

  const segments = useMemo(() => (routeResult ? splitByFloor(routeResult.path) : []), [routeResult]);
  const [segIndex, setSegIndex] = useState(0);

  // Walkable-area grids are only needed to draw a route, and rebuilding one on
  // every edit-mode drag would be wasted work — so they're built lazily, and
  // then kept, so clearing a route doesn't throw them away and pay for the
  // rebuild on the next search.
  const [gridsWanted, setGridsWanted] = useState(false);
  useEffect(() => {
    if (segments.length > 0) setGridsWanted(true);
  }, [segments.length]);
  const needGrids = gridsWanted && !editMode;
  const masks = useMemo(() => walkMasks(), []);
  const gridLower = useMemo(
    () => (needGrids ? buildWalkGrid(floors.lower, masks.lower) : null),
    [needGrids, floors.lower, masks]
  );
  const gridMain = useMemo(
    () => (needGrids ? buildWalkGrid(floors.main, masks.main) : null),
    [needGrids, floors.main, masks]
  );
  const gridUpper = useMemo(
    () => (needGrids ? buildWalkGrid(floors.upper, masks.upper) : null),
    [needGrids, floors.upper, masks]
  );
  const grids = useMemo<Record<FloorId, WalkGrid | null>>(
    () => ({ lower: gridLower, main: gridMain, upper: gridUpper }),
    [gridLower, gridMain, gridUpper]
  );

  // The graph says which points a route passes through; navmesh turns each hop
  // into a line that stays inside real walkable space.
  const legs = useMemo<RouteLeg[]>(() => {
    return segments.map((seg) => {
      const f = floors[seg.floor];
      const grid = grids[seg.floor];
      const pts = seg.points.map((id) => f.points[id]).filter(Boolean) as FloorPoint[];
      if (!grid || pts.length === 0) {
        return { floor: seg.floor, points: seg.points, path: pts.map((p) => [p.x, p.y] as [number, number]) };
      }
      const path: [number, number][] = [[pts[0].x, pts[0].y]];
      for (let i = 0; i < pts.length - 1; i++) {
        const hop = wallAwarePath(grid, [pts[i].x, pts[i].y], [pts[i + 1].x, pts[i + 1].y]);
        path.push(...hop.slice(1));
      }
      return { floor: seg.floor, points: seg.points, path };
    });
  }, [segments, floors, grids]);

  const directions = useMemo(() => {
    if (!fromItem || !toItem || legs.length === 0) return null;
    const endId = legs[legs.length - 1].points[legs[legs.length - 1].points.length - 1];
    const startId = legs[0].points[0];
    return buildDirections(legs, floors, startId, endId);
  }, [legs, floors, fromItem, toItem]);

  // Did this route lean on a link the app invented (see lib/autolink.ts)? If
  // so the drawn line near that end is a straight-line guess, and saying so is
  // better than quietly showing a confident-looking route.
  const usesGuessedLink = useMemo(() => {
    return segments.some((seg) => {
      const f = floors[seg.floor];
      for (let i = 0; i < seg.points.length - 1; i++) {
        const a = seg.points[i];
        const b = seg.points[i + 1];
        const edge = f.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
        if (edge?.auto) return true;
      }
      return false;
    });
  }, [segments, floors]);

  const currentLeg = legs[segIndex] ?? null;
  const routeStartId = currentLeg?.points[0] ?? null;
  const routeEndId = currentLeg?.points[currentLeg.points.length - 1] ?? null;
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
    (leg: RouteLeg | null) => {
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
    frameLeg(legs[segIndex] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segIndex, legs]);

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
    if (step.at) {
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
    setFloors((prev) => ({ ...prev, [floorId]: updater(prev[floorId]) }));
  }

  function onAddPoint(x: number, y: number) {
    const kind = tool === "add-restroom" ? "poi" : "junction";
    const id = kind === "poi" ? `poi-${Date.now()}` : `J_${Math.floor(Math.random() * 100000)}`;
    const point: FloorPoint = {
      x: Math.round(x),
      y: Math.round(y),
      kind,
      ...(kind === "poi" ? { poiType: "restroom", label: "Restroom" } : {}),
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

  function onToggleEdge(a: string, b: string) {
    updateFloor((f) => {
      const exists = f.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
      const edges = exists
        ? f.edges.filter((e) => !((e.a === a && e.b === b) || (e.a === b && e.b === a)))
        : [...f.edges, { a, b }];
      return { ...f, edges };
    });
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

              {usesGuessedLink && (
                <p className="hint caution">
                  Part of this route follows a link the app guessed, because no hallway is traced to
                  that spot yet — treat the last stretch as approximate.
                </p>
              )}
              {routeResult.usedStairs.length > 0 && (
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

      {editMode && (
        <div className="edit-panel">
          <p className="hint">
            Fix hallway paths, add restrooms, or move anything that's off — you're editing{" "}
            <strong>{FLOOR_LABELS[floorId]}</strong>.
          </p>
          <div className="tool-row">
            <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}>
              Move
            </button>
            <button
              className={tool === "add-junction" ? "active" : ""}
              onClick={() => setTool("add-junction")}
            >
              + Hallway point
            </button>
            <button className={tool === "connect" ? "active" : ""} onClick={() => setTool("connect")}>
              Connect
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
            {tool === "add-junction" &&
              "Click empty hallway space to drop a path point — put these where hallways actually bend, then use Connect to link them."}
            {tool === "connect" && "Click one point, then another, to add or remove the path between them."}
            {tool === "add-restroom" && "Click anywhere on the map to mark a restroom."}
          </p>

          {selectedPoint && (
            <div className="inspector">
              <p className="inspector-title">
                {selectedId} <span className="kind-tag">{selectedPoint.kind}</span>
              </p>
              {(selectedPoint.kind === "poi" || selectedPoint.kind === "junction") && (
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
              Stairs are placed at each shared entrance as a best guess — not yet confirmed against
              the real building.
            </li>
            <li>Restrooms aren't on the source plan — mark them with the editor.</li>
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
      <main className="map-area" ref={mapAreaRef}>
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
              imageSrc={FLOOR_IMAGES[floorId]}
              editMode={editMode}
              tool={tool}
              selectedId={selectedId}
              pendingConnectId={tool === "connect" ? selectedId : null}
              onSelectPoint={setSelectedId}
              onAddPoint={onAddPoint}
              onMovePoint={onMovePoint}
              onToggleEdge={onToggleEdge}
              routeLine={editMode ? null : currentLeg?.path ?? null}
              startPointId={editMode ? null : routeStartId}
              endPointId={editMode ? null : routeEndId}
              startLabel={
                !editMode && routeStartId && segIndex === 0
                  ? pointLabel(floor, routeStartId)
                  : null
              }
              endLabel={!editMode && routeEndId && isFinalLeg ? pointLabel(floor, routeEndId) : null}
              highlightAt={activeStep !== null ? directions?.steps[activeStep]?.at ?? null : null}
            />
          </TransformComponent>
        </TransformWrapper>

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
