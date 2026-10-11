// The bridge between React and the 3D viewer.
//
// Deliberately thin. React owns no three.js object and holds no scene state:
// it creates the viewer once, pushes props at it, and disposes it. Everything
// visual is decided inside MapViewer3D.
//
// The one piece of UI that lives here is the fly-the-route control, because
// it is a control for the viewer and nothing else: it calls straight into the
// viewer and shows the state the viewer reports back. Keeping it here also
// keeps it out of App.tsx, which has enough to do.

import { useEffect, useRef, useState } from "react";
import {
  MapViewer3D,
  type FlightState,
  type Viewer3DCallbacks,
  type Viewer3DProps,
} from "../three/viewer";

type Props = Viewer3DProps & Viewer3DCallbacks;

export default function MapCanvas3D(props: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<MapViewer3D | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [flight, setFlight] = useState<FlightState>("idle");

  // Created once. In StrictMode dev this runs twice, which is exactly why
  // dispose() has to be complete — browsers cap live WebGL contexts at ~16.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const viewer = new MapViewer3D(host, propsRef.current, {
      onPickFloor: (f) => propsRef.current.onPickFloor?.(f),
      onFocusFloor: (f) => propsRef.current.onFocusFloor?.(f),
      onFatal: (r) => propsRef.current.onFatal?.(r),
      onFlightChange: (s) => {
        setFlight(s);
        propsRef.current.onFlightChange?.(s);
      },
    });
    viewerRef.current = viewer;
    return () => {
      viewerRef.current = null;
      viewer.dispose();
    };
  }, []);

  // No dependency array on purpose. update() is a cheap diff against the
  // previous props; listing a dozen deps is a bug farm where one missed entry
  // means the 3D view silently stops tracking a piece of state.
  useEffect(() => {
    viewerRef.current?.update(props);
  });

  const hasRoute = props.route !== null && props.route.legs.length > 0;
  const v = () => viewerRef.current;

  return (
    <>
      <div className="map-3d" ref={hostRef} />
      {hasRoute && (
        // Kept above the phone's bottom sheet, which covers `obscuredBottom` px
        // of the map; otherwise the Stop button can end up under the sheet.
        <div
          className="fly-controls"
          role="group"
          aria-label="Fly the route"
          style={{ bottom: `${Math.round(props.obscuredBottom) + 16}px` }}
        >
          {flight === "idle" ? (
            <button className="fly-btn primary" onClick={() => v()?.startFlight()}>
              <span aria-hidden="true">▶</span> Fly the route
            </button>
          ) : (
            <>
              <button
                className="fly-btn primary"
                onClick={() => (flight === "flying" ? v()?.pauseFlight() : v()?.resumeFlight())}
              >
                {flight === "flying" ? "Pause" : "Resume"}
              </button>
              <button className="fly-btn" onClick={() => v()?.stopFlight()}>
                Stop
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
