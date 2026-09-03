import { useMemo, useRef, useState } from "react";
import type { FloorData, FloorPoint } from "../types";

export type EditTool = "select" | "add-junction" | "add-restroom" | "connect";

interface Props {
  floor: FloorData;
  imageSrc: string;
  editMode: boolean;
  tool: EditTool;
  selectedId: string | null;
  pendingConnectId: string | null;
  onSelectPoint: (id: string | null) => void;
  onAddPoint: (x: number, y: number) => void;
  onMovePoint: (id: string, x: number, y: number) => void;
  onToggleEdge: (a: string, b: string) => void;
  routeLine: [number, number][] | null; // wall-aware pixel path for this floor's leg
  startPointId: string | null;
  endPointId: string | null;
  startLabel: string | null;
  endLabel: string | null;
  highlightAt: [number, number] | null; // the step the user tapped in the directions
}

const CLICK_MOVE_THRESHOLD = 4;
const ARROW_SPACING = 260; // px between direction arrows along the route

export default function MapCanvas({
  floor,
  imageSrc,
  editMode,
  tool,
  selectedId,
  pendingConnectId,
  onSelectPoint,
  onAddPoint,
  onMovePoint,
  onToggleEdge,
  routeLine,
  startPointId,
  endPointId,
  startLabel,
  endLabel,
  highlightAt,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragState = useRef<{
    id: string;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);

  function toImageCoords(clientX: number, clientY: number): [number, number] {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const rect = svg.getBoundingClientRect();
    return [
      (clientX - rect.left) * (floor.image.w / rect.width),
      (clientY - rect.top) * (floor.image.h / rect.height),
    ];
  }

  function handleBackgroundClick(e: React.MouseEvent) {
    if (!editMode) return;
    if (e.target !== svgRef.current) return; // a point/edge already handled it
    if (tool === "add-junction" || tool === "add-restroom") {
      const [x, y] = toImageCoords(e.clientX, e.clientY);
      onAddPoint(x, y);
    } else if (tool === "select") {
      onSelectPoint(null);
    }
  }

  function handlePointerDown(id: string) {
    return (e: React.PointerEvent) => {
      if (!editMode) return;
      e.stopPropagation();
      if (tool === "select") {
        dragState.current = { id, startClientX: e.clientX, startClientY: e.clientY, moved: false };
        (e.target as Element).setPointerCapture(e.pointerId);
      }
    };
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragState.current;
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY) > CLICK_MOVE_THRESHOLD) {
      drag.moved = true;
    }
    if (drag.moved) {
      const [x, y] = toImageCoords(e.clientX, e.clientY);
      setDragPos({ id: drag.id, x, y });
    }
  }

  function handlePointerUp(e: React.PointerEvent) {
    const drag = dragState.current;
    dragState.current = null;
    if (!drag) return;
    if (drag.moved) {
      const [x, y] = toImageCoords(e.clientX, e.clientY);
      onMovePoint(drag.id, x, y);
      setDragPos(null);
    } else {
      handlePointClick(drag.id);
    }
  }

  function handlePointClick(id: string) {
    if (!editMode) return;
    if (tool === "connect") {
      if (pendingConnectId && pendingConnectId !== id) {
        onToggleEdge(pendingConnectId, id);
        onSelectPoint(null);
      } else {
        onSelectPoint(id);
      }
    } else if (tool === "select") {
      onSelectPoint(id);
    }
  }

  const points = floor.points;
  const routePath = routeLine && routeLine.length > 1 ? routeLine : null;

  // Little chevrons spaced along the route so it's obvious which way to walk.
  const arrows = useMemo(() => {
    if (!routePath) return [];
    const out: { x: number; y: number; angle: number }[] = [];
    let carry = ARROW_SPACING / 2;
    for (let i = 1; i < routePath.length; i++) {
      const [x0, y0] = routePath[i - 1];
      const [x1, y1] = routePath[i];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 1) continue;
      const angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
      let travelled = carry;
      while (travelled <= len) {
        out.push({
          x: x0 + ((x1 - x0) * travelled) / len,
          y: y0 + ((y1 - y0) * travelled) / len,
          angle,
        });
        travelled += ARROW_SPACING;
      }
      carry = travelled - len;
    }
    return out;
  }, [routePath]);

  const restrooms = Object.entries(points).filter(([, p]) => p.poiType === "restroom");

  return (
    <div className="map-canvas" style={{ width: floor.image.w, height: floor.image.h }}>
      <img src={imageSrc} alt={`Westlake High School — ${floor.label}`} draggable={false} />
      <svg
        ref={svgRef}
        className={`overlay${editMode ? " editable" : ""}`}
        width={floor.image.w}
        height={floor.image.h}
        viewBox={`0 0 ${floor.image.w} ${floor.image.h}`}
        onClick={handleBackgroundClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {editMode &&
          floor.edges.map((edge, i) => {
            const a = points[edge.a];
            const b = points[edge.b];
            if (!a || !b) return null;
            return (
              <line
                key={i}
                className={`edit-edge${edge.auto ? " auto" : ""}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}

        {routePath && (
          <>
            {/* soft casing under the dashes, so the route reads on a busy plan */}
            <polyline
              className="route-casing"
              points={routePath.map(([x, y]) => `${x},${y}`).join(" ")}
              fill="none"
            />
            <polyline
              className="route-line"
              points={routePath.map(([x, y]) => `${x},${y}`).join(" ")}
              fill="none"
            />
            {arrows.map((a, i) => (
              <g key={i} className="route-arrowhead" transform={`translate(${a.x},${a.y}) rotate(${a.angle})`}>
                <path d="M -9 -9 L 9 0 L -9 9 Z" />
              </g>
            ))}
          </>
        )}

        {!editMode &&
          restrooms.map(([id, p]) => (
            <g key={id} className="poi restroom" transform={`translate(${p.x},${p.y})`}>
              <circle r={20} />
              <text y={7} textAnchor="middle">
                WC
              </text>
            </g>
          ))}

        {highlightAt && (
          <g className="step-highlight" transform={`translate(${highlightAt[0]},${highlightAt[1]})`}>
            <circle r={46} />
            <circle r={30} className="inner" />
          </g>
        )}

        {startPointId && points[startPointId] && (
          <Pin
            p={points[startPointId]}
            className="marker start-marker"
            label={startLabel}
            radius={9}
          />
        )}
        {endPointId && points[endPointId] && (
          <Pin p={points[endPointId]} className="marker end-marker" label={endLabel} radius={11} />
        )}

        {editMode &&
          Object.entries(points).map(([id, p]) => {
            const pos = dragPos && dragPos.id === id ? dragPos : p;
            return (
              <g
                key={id}
                className={`edit-point kind-${p.kind}${selectedId === id ? " selected" : ""}${
                  pendingConnectId === id ? " pending" : ""
                }`}
                transform={`translate(${pos.x},${pos.y})`}
                onPointerDown={handlePointerDown(id)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tool !== "select") handlePointClick(id);
                }}
              >
                <circle r={p.kind === "room" ? 16 : 12} />
                {(p.kind === "junction" || p.kind === "poi") && <circle r={4} className="inner-dot" />}
              </g>
            );
          })}
      </svg>
    </div>
  );
}

function Pin({
  p,
  className,
  label,
  radius,
}: {
  p: FloorPoint;
  className: string;
  label: string | null;
  radius: number;
}) {
  const width = label ? Math.max(label.length * 17 + 44, 130) : 0;
  return (
    <g className={className} transform={`translate(${p.x},${p.y})`}>
      <circle r={radius * 2.6} className="halo" />
      <circle r={radius} className="dot" />
      {label && (
        <g className="pin-label" transform={`translate(0,${-radius * 2.6 - 16})`}>
          <rect x={-width / 2} y={-42} width={width} height={42} rx={12} />
          <text y={-14} textAnchor="middle">
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

export function labelForPoint(p: FloorPoint, id: string): string {
  return p.label ?? id;
}
