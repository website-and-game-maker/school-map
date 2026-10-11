// Fly-the-route: a low drone that follows the lifted route spine.
//
// This module decides WHERE the camera should be; the viewer decides when to
// ask and applies the answer. No Object3D, no scene access — it reads the same
// `Route3D` the ribbon is built from, through `sampleAt`, so the camera can
// never drift off the line it is supposed to be following.
//
// The route spine is a grid path with filleted corners, and following it
// literally makes the camera snap 90° at every corner — which reads as a cut,
// not as flight. Two things smooth it without reshaping the path (routeLift.ts
// explains why the path itself must not be splined):
//
//  1. Heading comes from a point `headingLookFt` AHEAD along the spine, not
//     from the local tangent, so the turn starts before the corner and is
//     spread across it.
//  2. That heading, and the camera position and aim, are each exponentially
//     damped. The yaw is damped as an angle (shortest way round), because
//     lerping two unit vectors through a U-turn passes through zero.
//
// Height is relative to the spine, so a stair riser is climbed: the camera
// rises with the route between storeys rather than cutting to the next one.

import * as THREE from "three";
import { sampleAt, type Route3D } from "./routeLift";
import { FLY, easeInOutCubic } from "./theme";

export interface FlightPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/** Fraction of the way to a target after `dt`, for a time constant `tau`.
 *  Frame-rate independent, unlike a fixed lerp factor. */
function damp(dt: number, tau: number): number {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class RouteFlight {
  /** Feet travelled along the spine. */
  private dist = 0;
  private yaw = 0;
  private readonly cam = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly idealCam = new THREE.Vector3();
  private readonly idealAim = new THREE.Vector3();
  private readonly from: FlightPose;
  private introT: number;
  private flyT = 0;
  private holdT = 0;
  private stopIndex = 0;
  /** Reduced motion: the distances to cut between, one per direction step. */
  private readonly stops: number[];
  private readonly route: Route3D;
  private readonly reduced: boolean;
  done = false;

  constructor(route: Route3D, from: FlightPose, reduced: boolean) {
    this.route = route;
    this.reduced = reduced;
    this.from = { position: from.position.clone(), target: from.target.clone() };
    this.yaw = this.headingAt(0) ?? 0;
    this.computeIdeal();
    this.cam.copy(this.idealCam);
    this.aim.copy(this.idealAim);
    // With reduced motion the descent is a cut too: no intro at all.
    this.introT = reduced ? 1 : 0;

    const stops = new Set<number>([0]);
    for (const idx of route.stepAnchors) {
      if (idx !== null) stops.add(Math.round(route.cumulative[idx]));
    }
    stops.add(Math.round(route.totalFt));
    this.stops = [...stops].sort((a, b) => a - b);
  }

  /** Still coming down from the user's view into the drone pose. The camera
   *  is not over the route yet, so nothing should follow its height. */
  get descending(): boolean {
    return this.introT < 1;
  }

  /** Advance by `dt` seconds and return the pose to render. */
  step(dt: number): FlightPose {
    if (this.reduced) return this.stepReduced(dt);

    if (this.introT < 1) {
      // Descend from wherever the user left the camera into the drone pose,
      // still sitting at the start: arriving and moving at once is too much.
      this.introT = Math.min(1, this.introT + dt / FLY.introS);
      const e = easeInOutCubic(this.introT);
      return {
        position: this.from.position.clone().lerp(this.cam, e),
        target: this.from.target.clone().lerp(this.aim, e),
      };
    }

    this.flyT += dt;
    const total = this.route.totalFt;
    const remaining = total - this.dist;
    // Ease off the start and settle onto the end. The floor of 0.18 is what
    // makes the approach actually arrive instead of creeping forever.
    const accel = Math.min(1, this.flyT / FLY.rampS);
    const settle = Math.max(0.18, Math.min(1, remaining / (FLY.speedFtPerS * FLY.rampS)));
    this.dist = Math.min(total, this.dist + FLY.speedFtPerS * Math.min(accel, settle) * dt);

    const target = this.headingAt(this.dist);
    if (target !== null) this.yaw += wrapAngle(target - this.yaw) * damp(dt, FLY.headingTauS);
    this.computeIdeal();
    const k = damp(dt, FLY.positionTauS);
    this.cam.lerp(this.idealCam, k);
    this.aim.lerp(this.idealAim, k);

    // Done once the path is used up and the damped camera has caught up.
    if (this.dist >= total && this.cam.distanceToSquared(this.idealCam) < 0.25) this.done = true;
    return { position: this.cam.clone(), target: this.aim.clone() };
  }

  /**
   * Reduced motion: hold at each direction step, then cut to the next. A cut
   * is not motion, so this still shows the route from the drone's point of
   * view, one instruction at a time, which is what the flight is for.
   */
  private stepReduced(dt: number): FlightPose {
    this.holdT += dt;
    if (this.holdT >= FLY.reducedHoldS) {
      this.holdT = 0;
      this.stopIndex++;
      if (this.stopIndex >= this.stops.length) this.done = true;
    }
    this.dist = this.stops[Math.min(this.stopIndex, this.stops.length - 1)];
    // At the destination there is no "ahead": keep the last heading.
    this.yaw = this.headingAt(this.dist) ?? this.yaw;
    this.computeIdeal();
    this.cam.copy(this.idealCam);
    this.aim.copy(this.idealAim);
    return { position: this.cam.clone(), target: this.aim.clone() };
  }

  /**
   * Yaw from the spine at `d` to the spine `headingLookFt` further on, in XZ.
   * Null when that is nearly vertical (a stair riser) or past the end, so the
   * caller keeps the heading it had rather than spinning on a degenerate one.
   */
  private headingAt(d: number): number | null {
    const total = this.route.totalFt;
    const a = sampleAt(this.route, d);
    const b = sampleAt(this.route, Math.min(total, d + FLY.headingLookFt));
    let dx = b.pos[0] - a.pos[0];
    let dz = b.pos[2] - a.pos[2];
    if (dx * dx + dz * dz < 4) {
      // Near the end the look point runs out of path: use the last tangent.
      if (d + FLY.headingLookFt <= total) return null;
      dx = a.tangent[0];
      dz = a.tangent[2];
      if (dx * dx + dz * dz < 1e-4) return null;
    }
    return Math.atan2(dx, dz);
  }

  private computeIdeal(): void {
    const s = sampleAt(this.route, this.dist);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const [px, py, pz] = s.pos;
    this.idealCam.set(px - fx * FLY.trailFt, py + FLY.heightFt, pz - fz * FLY.trailFt);
    // Aim at the floor ahead, not at the horizon: the room numbers are on the
    // floor. Height follows the spine, so on a riser the camera climbs with it
    // instead of craning up at the next storey.
    this.idealAim.set(px + fx * FLY.lookAheadFt, py, pz + fz * FLY.lookAheadFt);
  }
}
