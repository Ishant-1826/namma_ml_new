/**
 * jump_controller.ts
 * Teleport-style eased camera jump transition to POI anchors.
 * ZERO per-frame heap allocations (pre-allocated temporaries).
 * Eases camera position and yaw over ~0.8 s, levelling pitch to 0 and height to 1.45 m.
 * Cancels immediately on any user keyboard/mouse activity.
 */

import * as THREE from "three";
import { POI } from "../poi/poi_types";
import { FirstPersonControls, EYE_HEIGHT_M } from "../controls";
import { NavGrid } from "../nav/navgrid";
import { isCircleBlocked } from "../collision";
import {
  easeInOutCubic,
  interpolateAngleRad,
  computeFacingYaw,
  normalizeAngleRad,
} from "../poi/jump_math";

export interface JumpOptions {
  durationS?: number;
  playerRadius?: number;
  onComplete?: (poi: POI) => void;
  onCancel?: (poi: POI) => void;
  onError?: (error: string) => void;
}

export class JumpController {
  private _active = false;
  private _elapsedS = 0;
  private _durationS = 0.8;
  private _poi: POI | null = null;
  private _controls: FirstPersonControls | null = null;
  private _grid: NavGrid | null = null;

  // Pre-allocated static vectors & Euler to guarantee ZERO per-frame heap allocation
  private readonly _startPos = new THREE.Vector3();
  private readonly _targetPos = new THREE.Vector3();
  private _startYaw = 0;
  private _targetYaw = 0;
  private _startPitch = 0;
  private readonly _tempEuler = new THREE.Euler(0, 0, 0, "YXZ");

  private _onComplete?: (poi: POI) => void;
  private _onCancel?: (poi: POI) => void;

  isActive(): boolean {
    return this._active;
  }

  getCurrentTargetPOI(): POI | null {
    return this._poi;
  }

  startJump(
    controls: FirstPersonControls,
    grid: NavGrid,
    poi: POI,
    options: JumpOptions = {}
  ): boolean {
    // 1. Verify anchor validity: must be walkable and pass collision circle test
    const cell = grid.worldToCell(poi.anchor.x, poi.anchor.z);
    if (!grid.isCellWalkable(cell.col, cell.row)) {
      const err = `[Jump] Aborted: POI [${poi.name}] anchor (${poi.anchor.x.toFixed(2)}, ${poi.anchor.z.toFixed(2)}) is not in a walkable cell.`;
      console.warn(err);
      options.onError?.(err);
      return false;
    }

    const radius = options.playerRadius ?? controls.playerRadius;
    if (isCircleBlocked(grid.rawOccupancy, poi.anchor.x, poi.anchor.z, radius)) {
      const err = `[Jump] Aborted: POI [${poi.name}] anchor (${poi.anchor.x.toFixed(2)}, ${poi.anchor.z.toFixed(2)}) failed circle test at r=${radius}m.`;
      console.warn(err);
      options.onError?.(err);
      return false;
    }

    this._controls = controls;
    this._grid = grid;
    this._poi = poi;
    this._durationS = options.durationS ?? 0.8;
    this._elapsedS = 0;
    this._onComplete = options.onComplete;
    this._onCancel = options.onCancel;

    // Record start state
    this._startPos.copy(controls.camera.position);
    this._startYaw = controls.currentYawRad;
    this._startPitch = (controls.currentPitchDeg * Math.PI) / 180;

    // Target state: anchor X & Z, eye height 1.45m, yaw facing pin, pitch 0
    this._targetPos.set(poi.anchor.x, EYE_HEIGHT_M, poi.anchor.z);
    this._targetYaw = computeFacingYaw(poi.anchor.x, poi.anchor.z, poi.position.x, poi.position.z);

    this._active = true;
    console.log(
      `[Jump] Starting jump transition to "${poi.name}": ` +
      `from (${this._startPos.x.toFixed(2)}, ${this._startPos.z.toFixed(2)}) ` +
      `to anchor (${this._targetPos.x.toFixed(2)}, ${this._targetPos.z.toFixed(2)}) ` +
      `facing pin (${poi.position.x.toFixed(2)}, ${poi.position.z.toFixed(2)}) ` +
      `targetYaw=${((this._targetYaw * 180) / Math.PI).toFixed(1)}°`
    );

    return true;
  }

  /**
   * Called every frame in render loop with dt.
   * Smoothly interpolates camera position and orientation using cubic ease-in-out.
   */
  update(dt: number): void {
    if (!this._active || !this._controls || !this._poi) return;

    this._elapsedS += dt;
    const progress = Math.min(1.0, this._elapsedS / this._durationS);
    const easeT = easeInOutCubic(progress);

    // Eased position
    const cam = this._controls.camera;
    cam.position.x = this._startPos.x + (this._targetPos.x - this._startPos.x) * easeT;
    cam.position.y = this._startPos.y + (this._targetPos.y - this._startPos.y) * easeT;
    cam.position.z = this._startPos.z + (this._targetPos.z - this._startPos.z) * easeT;

    // Eased orientation (level pitch to 0, interpolate yaw to face pin)
    const curYaw = interpolateAngleRad(this._startYaw, this._targetYaw, easeT);
    const curPitch = this._startPitch * (1 - easeT);

    this._tempEuler.set(curPitch, curYaw, 0, "YXZ");
    cam.quaternion.setFromEuler(this._tempEuler);

    if (progress >= 1.0) {
      this.finishJump();
    }
  }

  /**
   * Finalizes jump at target anchor with velocity and headbob zeroed,
   * matching Round 1's teleport/reset mechanics.
   */
  private finishJump(): void {
    if (!this._controls || !this._poi) return;
    const poi = this._poi;
    const targetX = this._targetPos.x;
    const targetZ = this._targetPos.z;
    const targetYaw = this._targetYaw;

    // Reset jump state before calling controls
    this._active = false;
    this._controls.teleportTo(targetX, EYE_HEIGHT_M, targetZ, targetYaw, 0);

    console.log(
      `[Jump] Jump complete at "${poi.name}" anchor: ` +
      `(${targetX.toFixed(3)}, ${targetZ.toFixed(3)}), yaw=${((targetYaw * 180) / Math.PI).toFixed(1)}°`
    );

    const cb = this._onComplete;
    this._poi = null;
    this._controls = null;
    cb?.(poi);
  }

  /**
   * Cancels jump immediately on user input, leaving player at current valid position.
   */
  cancelJump(reason = "user input"): void {
    if (!this._active || !this._controls) return;
    const poi = this._poi;
    this._active = false;

    // Clamp current position to valid walkable spot and zero velocity
    const cam = this._controls.camera;
    this._tempEuler.setFromQuaternion(cam.quaternion, "YXZ");
    this._controls.teleportTo(cam.position.x, EYE_HEIGHT_M, cam.position.z, this._tempEuler.y, this._tempEuler.x);

    console.log(`[Jump] Jump cancelled (${reason}) at (${cam.position.x.toFixed(2)}, ${cam.position.z.toFixed(2)})`);

    const cb = this._onCancel;
    this._poi = null;
    this._controls = null;
    if (poi) {
      cb?.(poi);
    }
  }
}
