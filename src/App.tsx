import { useMemo, useRef, useState } from "react";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import mainLevelImg from "./assets/main-level.jpg";
import data from "./data/mainLevel.json";
import { buildAdjacency, shortestPath, type GraphData, type Point } from "./lib/pathfind";
import "./App.css";

const graph = data as unknown as GraphData;
const adjacency = buildAdjacency(graph);
const roomNames = Object.keys(graph.rooms).sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true })
);

function toPointString(points: Point[]): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

export default function App() {
  const [start, setStart] = useState<string>("Entrance C");
  const [query, setQuery] = useState("");
  const [destination, setDestination] = useState<string | null>(null);
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const mapAreaRef = useRef<HTMLDivElement | null>(null);

  const suggestions = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.trim().toLowerCase();
    return roomNames.filter((r) => r.toLowerCase().startsWith(q)).slice(0, 8);
  }, [query]);

  const path = useMemo(() => {
    if (!destination) return null;
    return shortestPath(adjacency, start, destination);
  }, [start, destination]);

  const pathPoints: Point[] = useMemo(() => {
    if (!path) return [];
    return path.map((id) => graph.nodes[id] ?? graph.rooms[id] ?? graph.landmarks[id]);
  }, [path]);

  function selectRoom(room: string) {
    setDestination(room);
    setQuery(room);
    const target = graph.rooms[room];
    const area = mapAreaRef.current;
    if (target && transformRef.current && area) {
      const scale = 0.6;
      transformRef.current.setTransform(
        -(target[0] * scale - area.clientWidth / 2),
        -(target[1] * scale - area.clientHeight / 2),
        scale,
        400
      );
    }
  }

  const startPoint = graph.nodes[start];
  const endPoint = destination ? graph.rooms[destination] : null;

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
            <button className="floor-tab active">Main Level</button>
            <button className="floor-tab" disabled title="Coming soon">
              Lower Level
            </button>
            <button className="floor-tab" disabled title="Coming soon">
              Upper Level
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="start-select">Start from</label>
          <select
            id="start-select"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          >
            {graph.entrances.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="room-search">Room number</label>
          <input
            id="room-search"
            placeholder="e.g. 245, 288B, 210D"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setDestination(null);
            }}
            autoComplete="off"
          />
          {suggestions.length > 0 && (
            <ul className="suggestions">
              {suggestions.map((r) => (
                <li key={r}>
                  <button onClick={() => selectRoom(r)}>{r}</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {destination && !path && (
          <p className="notice">Couldn't find a route to {destination} yet.</p>
        )}

        {path && (
          <div className="route-summary">
            <p>
              <strong>{start}</strong> &rarr; <strong>{destination}</strong>
            </p>
            <p className="hint">Follow the highlighted path on the map.</p>
            <button className="clear-btn" onClick={() => { setDestination(null); setQuery(""); }}>
              Clear route
            </button>
          </div>
        )}

        <div className="roadmap">
          <p className="roadmap-title">Coming later</p>
          <ul>
            <li>Lower &amp; Upper level maps + stairs/elevators between floors</li>
            <li>Photo walkthroughs along each route</li>
            <li>Live hallway traffic between passing periods</li>
            <li>Class name / teacher search</li>
          </ul>
        </div>

        <p className="disclaimer">
          v1 prototype — room positions are approximate, traced from the official floor plan. Tell me what's off and I'll fix it.
        </p>
      </aside>

      <main className="map-area" ref={mapAreaRef}>
        <TransformWrapper
          ref={transformRef}
          initialScale={0.35}
          minScale={0.15}
          maxScale={2.5}
          limitToBounds={false}
        >
          <TransformComponent wrapperClass="tp-wrapper" contentClass="tp-content">
            <div className="map-canvas" style={{ width: graph.image.w, height: graph.image.h }}>
              <img src={mainLevelImg} alt="Westlake High School — Main Level floor plan" draggable={false} />
              <svg
                className="overlay"
                width={graph.image.w}
                height={graph.image.h}
                viewBox={`0 0 ${graph.image.w} ${graph.image.h}`}
              >
                {pathPoints.length > 1 && (
                  <polyline
                    className="route-line"
                    points={toPointString(pathPoints)}
                    fill="none"
                  />
                )}
                {startPoint && (
                  <g className="marker start-marker" transform={`translate(${startPoint[0]},${startPoint[1]})`}>
                    <circle r={22} />
                    <circle r={8} className="dot" />
                  </g>
                )}
                {endPoint && (
                  <g className="marker end-marker" transform={`translate(${endPoint[0]},${endPoint[1]})`}>
                    <circle r={26} />
                    <circle r={9} className="dot" />
                  </g>
                )}
              </svg>
            </div>
          </TransformComponent>
        </TransformWrapper>
      </main>
    </div>
  );
}
