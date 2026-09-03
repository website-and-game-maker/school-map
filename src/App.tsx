import { useEffect, useMemo, useRef, useState } from "react";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import MapCanvas, { type EditTool } from "./components/MapCanvas";
import { FLOOR_IMAGES, FLOOR_ORDER, INITIAL_FLOORS, INITIAL_STAIRS } from "./data/floors";
import {
  buildAdjacency,
  nodeKey,
  shortestPathMulti,
  splitByFloor,
  type FloorSegment,
} from "./lib/pathfind";
import { downloadJson, saveFloorToDisk } from "./lib/save";
import type { FloorData, FloorId, FloorPoint } from "./types";
import "./App.css";

const FLOOR_LABELS: Record<FloorId, string> = {
  lower: "Lower Level",
  main: "Main Level",
  upper: "Upper Level",
};

interface SearchItem {
  id: string;
  floor: FloorId;
  label: string;
  kind: "room" | "restroom";
}

const RESTROOM_WORDS = ["restroom", "bathroom", "toilet", "wc"];

export default function App() {
  const [floors, setFloors] = useState<Record<FloorId, FloorData>>(INITIAL_FLOORS);
  const [stairs] = useState(INITIAL_STAIRS);
  const [floorId, setFloorId] = useState<FloorId>("main");
  const [start, setStart] = useState<string>("Entrance C");
  const [query, setQuery] = useState("");
  const [destQuery, setDestQuery] = useState<
    { kind: "room"; floor: FloorId; id: string } | { kind: "restroom" } | null
  >(null);

  const [editMode, setEditMode] = useState(false);
  const [tool, setTool] = useState<EditTool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string>("");

  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const mapAreaRef = useRef<HTMLDivElement | null>(null);

  const floor = floors[floorId];

  const adjacency = useMemo(() => buildAdjacency(floors, stairs), [floors, stairs]);

  const entranceNames = useMemo(() => {
    const set = new Set<string>();
    for (const f of FLOOR_ORDER) {
      for (const p of Object.values(floors[f].points)) {
        if (p.kind === "entrance" && p.label) set.add(p.label);
      }
      for (const id of floors[f].entrances) set.add(id);
    }
    return Array.from(set).sort();
  }, [floors]);

  const searchIndex = useMemo<SearchItem[]>(() => {
    const items: SearchItem[] = [];
    for (const f of FLOOR_ORDER) {
      for (const [id, p] of Object.entries(floors[f].points)) {
        if (p.kind === "room") items.push({ id, floor: f, label: id, kind: "room" });
        else if (p.kind === "poi" && p.poiType === "restroom") {
          items.push({ id, floor: f, label: p.label ?? "Restroom", kind: "restroom" });
        }
      }
    }
    return items;
  }, [floors]);

  const restroomCount = useMemo(
    () => searchIndex.filter((i) => i.kind === "restroom").length,
    [searchIndex]
  );

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    if (RESTROOM_WORDS.some((w) => w.startsWith(q) || q.startsWith(w.slice(0, 3)))) {
      if (restroomCount > 0) {
        return [{ id: "__restroom__", floor: floorId, label: "Nearest restroom", kind: "restroom" as const }];
      }
      return [];
    }
    return searchIndex
      .filter((i) => i.kind === "room" && i.id.toLowerCase().startsWith(q))
      .slice(0, 8);
  }, [query, searchIndex, restroomCount, floorId]);

  const routeResult = useMemo(() => {
    if (!destQuery) return null;
    const starts = FLOOR_ORDER.filter((f) => floors[f].points[start]).map((f) => nodeKey(f, start));
    if (starts.length === 0) return null;

    let ends: string[];
    if (destQuery.kind === "restroom") {
      ends = searchIndex.filter((i) => i.kind === "restroom").map((i) => nodeKey(i.floor, i.id));
    } else {
      ends = [nodeKey(destQuery.floor, destQuery.id)];
    }
    if (ends.length === 0) return null;
    return shortestPathMulti(adjacency, starts, ends);
  }, [destQuery, start, floors, adjacency, searchIndex]);

  const segments: FloorSegment[] = useMemo(
    () => (routeResult ? splitByFloor(routeResult.path) : []),
    [routeResult]
  );
  const [segIndex, setSegIndex] = useState(0);

  useEffect(() => {
    setSegIndex(0);
    if (segments.length > 0) setFloorId(segments[0].floor);
  }, [routeResult]); // eslint-disable-line react-hooks/exhaustive-deps

  function centerOn(id: string | undefined, targetFloor: FloorId) {
    const area = mapAreaRef.current;
    const pt = id ? floors[targetFloor].points[id] : undefined;
    if (pt && transformRef.current && area) {
      const scale = 0.6;
      transformRef.current.setTransform(
        -(pt.x * scale - area.clientWidth / 2),
        -(pt.y * scale - area.clientHeight / 2),
        scale,
        400
      );
    }
  }

  function selectDestination(item: SearchItem) {
    if (item.kind === "restroom" && item.id === "__restroom__") {
      setDestQuery({ kind: "restroom" });
      setQuery("Nearest restroom");
    } else {
      setDestQuery({ kind: "room", floor: item.floor, id: item.id });
      setQuery(item.label);
    }
  }

  useEffect(() => {
    const seg = segments[segIndex];
    if (seg) centerOn(seg.points[seg.points.length - 1], seg.floor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segIndex, segments]);

  function goToSegment(i: number) {
    const seg = segments[i];
    if (!seg) return;
    setSegIndex(i);
    setFloorId(seg.floor);
  }

  function switchFloor(f: FloorId) {
    setFloorId(f);
    const segIdx = segments.findIndex((s) => s.floor === f);
    if (segIdx >= 0) setSegIndex(segIdx);
  }

  function clearRoute() {
    setDestQuery(null);
    setQuery("");
  }

  // ---------------- Edit mode ----------------

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
      const edges = f.edges.filter((e) => e.a !== id && e.b !== id);
      return { ...f, points, edges };
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
      setSaveStatus("Dev server not reachable — downloading instead");
      downloadJson(`${floorId}.json`, floors[floorId]);
    }
    setTimeout(() => setSaveStatus(""), 4000);
  }

  const selectedPoint = selectedId ? floor.points[selectedId] : null;
  const currentSeg = segments[segIndex];
  const routeStart = currentSeg?.points[0] ?? null;
  const routeEnd = currentSeg?.points[currentSeg.points.length - 1] ?? null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">W</span>
          <div>
            <h1>Westlake Map</h1>
            <p className="subtitle">Find your way. Home of the Chaps.</p>
          </div>
        </div>

        <div className="field">
          <label>Floor</label>
          <div className="floor-tabs">
            {FLOOR_ORDER.map((f) => (
              <button
                key={f}
                className={`floor-tab${floorId === f ? " active" : ""}`}
                onClick={() => switchFloor(f)}
              >
                {FLOOR_LABELS[f]}
                {segments.some((s) => s.floor === f) && <span className="route-dot" />}
              </button>
            ))}
          </div>
        </div>

        {!editMode && (
          <>
            <div className="field">
              <label htmlFor="start-select">Start from</label>
              <select id="start-select" value={start} onChange={(e) => setStart(e.target.value)}>
                {entranceNames.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="room-search">Room number, or "restroom"</label>
              <input
                id="room-search"
                placeholder="e.g. 245, 288B, 210D, restroom"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setDestQuery(null);
                }}
                autoComplete="off"
              />
              {suggestions.length > 0 && (
                <ul className="suggestions">
                  {suggestions.map((r) => (
                    <li key={`${r.floor}-${r.id}`}>
                      <button onClick={() => selectDestination(r)}>
                        {r.label}
                        {r.kind === "room" && <span className="sugg-floor">{FLOOR_LABELS[r.floor]}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {destQuery && !routeResult && (
              <p className="notice">Couldn't find a route there yet.</p>
            )}

            {routeResult && segments.length > 0 && (
              <div className="route-summary">
                <p className="route-path">
                  {segments.map((s, i) => (
                    <span key={i}>
                      {i > 0 && <span className="route-arrow"> ⇢ </span>}
                      <button
                        className={`seg-chip${i === segIndex ? " active" : ""}`}
                        onClick={() => goToSegment(i)}
                      >
                        {FLOOR_LABELS[s.floor]}
                      </button>
                    </span>
                  ))}
                </p>
                {routeResult.usedStairs.length > 0 && (
                  <p className="hint">
                    Uses {routeResult.usedStairs.length} stair
                    {routeResult.usedStairs.length > 1 ? "s" : ""} —{" "}
                    <strong>not yet confirmed</strong>, see below.
                  </p>
                )}
                <p className="hint">
                  {start} → {query || "destination"} · segment {segIndex + 1}/{segments.length}
                </p>
                <button className="clear-btn" onClick={clearRoute}>
                  Clear route
                </button>
              </div>
            )}
          </>
        )}

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
                "Click empty hallway space to drop a path point — place these where hallways actually bend, then use Connect to link them."}
              {tool === "connect" &&
                "Click one point, then another, to add or remove the path between them."}
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
              <button className="download-btn" onClick={() => downloadJson(`${floorId}.json`, floors[floorId])}>
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
                Stairs between floors are placed at each shared entrance as a best guess — not yet
                confirmed against the real building.
              </li>
              <li>Photo walkthroughs along each route</li>
              <li>Live hallway traffic between passing periods</li>
              <li>Class name / teacher search</li>
            </ul>
          </div>
        )}

        <p className="disclaimer">
          Room and hallway positions were traced by eye from the official floor plan — use{" "}
          <strong>Edit this floor</strong> above to straighten out anything that's wrong.
        </p>
      </aside>

      <main className="map-area" ref={mapAreaRef}>
        <TransformWrapper
          ref={transformRef}
          initialScale={0.35}
          minScale={0.15}
          maxScale={2.5}
          limitToBounds={false}
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
              routePoints={currentSeg ? currentSeg.points : null}
              startPointId={editMode ? null : routeStart}
              endPointId={editMode ? null : routeEnd}
            />
          </TransformComponent>
        </TransformWrapper>
      </main>
    </div>
  );
}
