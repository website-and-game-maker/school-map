// The bridge between React and the 3D viewer.
//
// Deliberately thin. React owns no three.js object and holds no scene state:
// it creates the viewer once, pushes props at it, and disposes it. Everything
// visual is decided inside MapViewer3D.

import { useEffect, useRef } from "react";
import { MapViewer3D, type Viewer3DCallbacks, type Viewer3DProps } from "../three/viewer";

type Props = Viewer3DProps & Viewer3DCallbacks;

export default function MapCanvas3D(props: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<MapViewer3D | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Created once. In StrictMode dev this runs twice, which is exactly why
  // dispose() has to be complete — browsers cap live WebGL contexts at ~16.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const viewer = new MapViewer3D(host, propsRef.current, {
      onPickFloor: (f) => propsRef.current.onPickFloor?.(f),
      onFocusFloor: (f) => propsRef.current.onFocusFloor?.(f),
      onFatal: (r) => propsRef.current.onFatal?.(r),
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

  return <div className="map-3d" ref={hostRef} />;
}
