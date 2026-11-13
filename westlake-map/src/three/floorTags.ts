// The floor names that ride on the storey stack.
//
// Tilted, all three floors are on screen at once, and a stack of plates means
// nothing until each one says which floor it is. Each storey gets a small
// pill, standing in a column beside the building at that storey's height;
// the floor being read is the solid one. Tapping a pill moves you to that floor, the same as the chips.

import * as THREE from "three";
import type { FloorId } from "../types";

export class FloorTags {
  private el: HTMLDivElement;
  private nodes = new Map<FloorId, HTMLButtonElement>();
  private anchors = new Map<FloorId, THREE.Vector3>();
  private v = new THREE.Vector3();

  constructor(host: HTMLElement, labels: Record<FloorId, string>, onPick: (f: FloorId) => void) {
    this.el = document.createElement("div");
    this.el.className = "floor-tags";
    host.appendChild(this.el);
    for (const f of Object.keys(labels) as FloorId[]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "floor-tag";
      b.textContent = labels[f];
      b.style.visibility = "hidden";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onPick(f);
      });
      this.el.appendChild(b);
      this.nodes.set(f, b);
    }
  }

  /** Where each storey's tag sits, in world feet. */
  setAnchor(floor: FloorId, at: THREE.Vector3): void {
    this.anchors.set(floor, at.clone());
  }

  layout(camera: THREE.Camera, w: number, h: number, active: FloorId, shown: boolean, left = 0): void {
    for (const [f, b] of this.nodes) {
      const at = this.anchors.get(f);
      let show = shown && !!at;
      if (show && at) {
        this.v.copy(at).project(camera);
        const x = ((this.v.x + 1) / 2) * w;
        const y = ((1 - this.v.y) / 2) * h;
        // The pill hangs left of its anchor; off the left edge it is pushed
        // back on screen (and out from under the panel) rather than cut off.
        const bw = b.offsetWidth || 60;
        const px = Math.max(x, left + bw + 16);
        show = this.v.z >= -1 && this.v.z <= 1 && x < w - 4 && y > 4 && y < h - 4;
        if (show) b.style.transform = `translate(${px.toFixed(1)}px, ${y.toFixed(1)}px) translate(-100%, -50%)`;
      }
      b.style.visibility = show ? "visible" : "hidden";
      b.classList.toggle("active", f === active);
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
