// The hand-drawn tour map, as a reference layer over the app.
//
// This is a photograph of a paper map somebody annotated by hand — building
// outlines highlighted per campus, entrances circled, and on the second page a
// full day of walking routes drawn period by period in different colours.
//
// It is deliberately NOT registered to the floor plans. It is a sketch: the
// proportions are hand-drawn and it flattens all three storeys onto one sheet,
// so any attempt to warp it onto the real plan would be a lie about how
// accurate it is. What it is good for is checking the app against a human —
// draw a route in the app, open this, and see whether a person who actually
// walks the building every day agrees with it.

import { useState } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import tourMap from "../assets/tour-map.jpg";
import tourMapRoutes from "../assets/tour-map-routes.jpg";

type Page = "map" | "routes";

export default function TourOverlay({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState<Page>("routes");

  return (
    <div className="tour-overlay" role="dialog" aria-label="Tour map">
      <div className="tour-bar">
        <div className="tour-tabs">
          <button
            className={page === "map" ? "active" : ""}
            onClick={() => setPage("map")}
          >
            Tour map
          </button>
          <button
            className={page === "routes" ? "active" : ""}
            onClick={() => setPage("routes")}
          >
            A day's routes
          </button>
        </div>
        <button className="tour-close" onClick={onClose} aria-label="Close tour map">
          ✕
        </button>
      </div>

      <div className="tour-body">
        <TransformWrapper
            // The scans are 2400px wide, so open zoomed out far enough to see the
            // whole sheet — the point of this layer is the shape of a day, not a
            // single corridor. minScale has to go below fit-width or the initial
            // view is clamped back in.
            initialScale={0.28}
            minScale={0.12}
            maxScale={8}
            centerOnInit
            limitToBounds={false}
          >
          <TransformComponent
            wrapperClass="tour-tp"
            contentClass="tour-tp-content"
            // The wrapper otherwise sizes itself to the image's natural 2400px,
            // and centerOnInit then centres within *that*, parking the sheet off
            // the side of a much narrower pane.
            wrapperStyle={{ width: "100%", height: "100%" }}
          >
            <img
              src={page === "map" ? tourMap : tourMapRoutes}
              alt={
                page === "map"
                  ? "Hand-drawn map of the school, colour-coded by campus"
                  : "The same map with a day of walking routes drawn on, period by period"
              }
            />
          </TransformComponent>
        </TransformWrapper>
      </div>

      <p className="tour-note">
        {page === "routes"
          ? "Drawn by hand, one colour per transition — 1st to 2nd through to the exit. Pinch or scroll to zoom."
          : "Campus colour key, room-number ranges and the entrances worth knowing. Pinch or scroll to zoom."}
      </p>
    </div>
  );
}
