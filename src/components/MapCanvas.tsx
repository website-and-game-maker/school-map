import { useRef, useState } from "react";
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
  routePoints: string[] | null; // point ids, in order, for the segment on this floor
  startPointId: string | null;
  endPointId: string | null;
}

const CLICK_MOVE_THRESHOLD = 4;

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
  routePoints,
  startPointId,
  endPointId,
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
    const scaleX = floor.image.w / rect.width;
    const scaleY = floor.image.h / rect.height;
    return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
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
        dragState.current = {
          id,
          startClientX: e.clientX,
          startClientY: e.clientY,
          moved: false,
        };
        (e.target as Element).setPointerCapture(e.pointerId);
      }
    };
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragState.current;
    if (!drag) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD) drag.moved = true;
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
  const routeLine =
    routePoints && routePoints.length > 1
      ? routePoints.map((id) => points[id]).filter(Boolean)
      : null;

  const showEditablePoints = editMode;
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
                className="edit-edge"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}

        {routeLine && (
          <polyline
            className="route-line"
            points={routeLine.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
          />
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

        {startPointId && points[startPointId] && (
          <g
            className="marker start-marker"
            transform={`translate(${points[startPointId].x},${points[startPointId].y})`}
          >
            <circle r={22} />
            <circle r={8} className="dot" />
          </g>
        )}
        {endPointId && points[endPointId] && (
          <g
            className="marker end-marker"
            transform={`translate(${points[endPointId].x},${points[endPointId].y})`}
          >
            <circle r={26} />
            <circle r={9} className="dot" />
          </g>
        )}

        {showEditablePoints &&
          Object.entries(points).map(([id, p]) => {
            const pos = dragPos && dragPos.id === id ? dragPos : p;
            const isSelected = selectedId === id;
            const isPending = pendingConnectId === id;
            return (
              <g
                key={id}
                className={`edit-point kind-${p.kind}${isSelected ? " selected" : ""}${
                  isPending ? " pending" : ""
                }`}
                transform={`translate(${pos.x},${pos.y})`}
                onPointerDown={handlePointerDown(id)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tool !== "select") handlePointClick(id);
                }}
              >
                <circle r={p.kind === "room" ? 16 : 12} />
                {(p.kind === "junction" || p.kind === "poi") && (
                  <circle r={4} className="inner-dot" />
                )}
              </g>
            );
          })}
      </svg>
    </div>
  );
}

export function labelForPoint(p: FloorPoint, id: string): string {
  return p.label ?? id;
}
