/**
 * navigation_controller.ts
 * High-level navigation controller coordinating route state, A* pathfinding,
 * 3D floor route rendering, guidance HUD, minimap route display, auto-walk,
 * debounced re-routing, and debug overlay (Key O).
 *
 * ZERO per-frame heap allocation in the render loop.
 */

import * as THREE from "three";
import { POI } from "../poi/poi_types";
import { NavGrid, NavGridPoint } from "../nav/navgrid";
import { findPath, PathSuccess } from "../nav/pathfinder";
import { isCircleBlocked, OccupancyGrid } from "../collision";
import { FirstPersonControls } from "../controls";
import { Minimap } from "../minimap";
import {
  RouteState,
  createInitialRouteState,
  startNavigationRoute,
  beginReroute,
  applyReroutedPath,
  checkArrivalState,
  clearActiveRoute,
  setAutoWalkState,
  setDebugOverlayState,
} from "../nav/route_state";
import {
  PathProjection,
  NavigationInstruction,
  TurnEvent,
  GuidanceStateTracker,
  projectPlayerOnPath,
  generateInstruction,
  extractTurnEvents,
  WALK_SPEED_MPS,
} from "../nav/instructions";
import { RouteRenderer } from "./route_renderer";
import { GuidanceHUD } from "./guidance_hud";

export interface NavigationControllerConfig {
  navGrid: () => NavGrid | null;
  occupancy: () => OccupancyGrid | null;
  camera: THREE.PerspectiveCamera;
  controls: FirstPersonControls;
  minimap: Minimap;
  routeRenderer: RouteRenderer;
  guidanceHUD: GuidanceHUD;
  showToast: (msg: string) => void;
}

export class NavigationController {
  private readonly config: NavigationControllerConfig;
  private _state: RouteState = createInitialRouteState();

  // Pre-allocated temporaries to guarantee ZERO per-frame heap allocations
  private readonly _projTemp: PathProjection = {
    nearestPoint: { x: 0, z: 0 },
    distanceOffPathM: 0,
    segmentIndex: 0,
    segmentT: 0,
    distanceAlongPathM: 0,
    remainingDistanceM: 0,
  };

  private readonly _instTemp: NavigationInstruction = {
    type: "continue",
    text: "",
    distanceToEventM: 0,
    remainingDistanceM: 0,
    etaSeconds: 0,
    progressFraction: 0,
  };

  private _autoWalkDistAlongM = 0;
  private _autoWalkStartTimeMs = 0;
  private _lastSegIdx = 0;
  private _lastDebugLogTimeMs = 0;
  private _precomputedTurns: TurnEvent[] = [];
  private readonly _guidanceTracker: GuidanceStateTracker = {
    activeTurnIndex: 0,
    initialHeadingResolved: false,
  };

  constructor(config: NavigationControllerConfig) {
    this.config = config;
  }

  getState(): RouteState {
    return this._state;
  }

  isActive(): boolean {
    return this._state.status === "navigating" || this._state.status === "rerouting";
  }

  isAutoWalking(): boolean {
    return this._state.autoWalkActive;
  }

  isDebugOverlay(): boolean {
    return this._state.debugOverlayActive;
  }

  /**
   * Starts navigation to the specified POI.
   * Computes A* path from current player position to POI anchor.
   */
  startNavigation(targetPOI: POI): boolean {
    const grid = this.config.navGrid();
    if (!grid) {
      this.config.showToast("Navigation grid not ready");
      return false;
    }

    const cam = this.config.camera;
    const startPoint: NavGridPoint = { x: cam.position.x, z: cam.position.z };
    const goalPoint: NavGridPoint = { x: targetPOI.anchor.x, z: targetPOI.anchor.z };

    // Pathfinding with debug option if overlay is active
    const pathRes = findPath(grid, startPoint, goalPoint, {
      playerRadius: 0.08,
      snapStart: true,
      snapGoal: false,
      collectExplored: this._state.debugOverlayActive,
    });

    if ("error" in pathRes) {
      const errReason =
        pathRes.error === "unreachable"
          ? "Target anchor is unreachable from current position"
          : pathRes.error === "start-blocked"
          ? "Starting position is inside a blocked area"
          : "Target anchor is blocked";
      this.config.showToast(errReason);
      return false;
    }

    const success = pathRes as PathSuccess;

    // Transition state machine
    this._state = startNavigationRoute(
      this._state,
      targetPOI,
      success.points,
      success.lengthM,
      success.computeMs,
      success.expandedNodes,
      success.rawPoints,
      success.exploredCells
    );

    // Reset monotonic tracker & precompute turns
    this._lastSegIdx = 0;
    this._guidanceTracker.activeTurnIndex = 0;
    this._guidanceTracker.initialHeadingResolved = false;
    this._precomputedTurns = extractTurnEvents(success.points);

    // Initial monotonic projection
    projectPlayerOnPath(success.points, cam.position.x, cam.position.z, this._projTemp, this._lastSegIdx);
    this._lastSegIdx = this._projTemp.segmentIndex;
    this._autoWalkDistAlongM = this._projTemp.distanceAlongPathM;

    // Update 3D route chevrons & vertical beacon
    this.config.routeRenderer.setRoute(success.points, targetPOI.anchor);

    // Update minimap route polyline & debug overlay
    this.config.minimap.setRoute(success.points, targetPOI.anchor);
    this.config.minimap.setDebugOverlay(
      this._state.debugOverlayActive,
      success.rawPoints,
      success.exploredCells
    );

    // Pulse minimap pin
    this.config.minimap.pulsePOI(targetPOI.id, 2000);

    // Update guidance HUD
    generateInstruction(
      success.points,
      this._projTemp,
      success.lengthM,
      targetPOI.name,
      this.config.controls.currentYawRad,
      this._instTemp,
      this._guidanceTracker,
      this._precomputedTurns
    );
    this.config.guidanceHUD.update(this._state, this._instTemp);

    console.log(
      `[Navigation] Route computed to "${targetPOI.name}": length=${success.lengthM.toFixed(
        2
      )}m, nodes=${success.expandedNodes}, time=${success.computeMs.toFixed(2)}ms`
    );

    return true;
  }

  /**
   * Clears active route and returns to idle state (Key C).
   */
  clearRoute(): void {
    if (this._state.status === "idle") return;

    this.cancelAutoWalk("route cleared");
    this._state = clearActiveRoute(this._state);

    this._lastSegIdx = 0;
    this._precomputedTurns = [];
    this._guidanceTracker.activeTurnIndex = 0;
    this._guidanceTracker.initialHeadingResolved = false;

    this.config.routeRenderer.clear();
    this.config.minimap.setRoute(null, null);
    this.config.minimap.setDebugOverlay(this._state.debugOverlayActive, null, null);
    this.config.guidanceHUD.hide();
    console.log("[Navigation] Route cleared");
  }

  /**
   * Toggles Auto-Walk (Key G or HUD button).
   */
  toggleAutoWalk(): void {
    if (!this.isActive() || !this._state.path) {
      this.config.showToast("No active route to follow");
      return;
    }

    const willActivate = !this._state.autoWalkActive;
    if (willActivate) {
      // Sync auto-walk progress to current projected player position
      projectPlayerOnPath(
        this._state.path,
        this.config.camera.position.x,
        this.config.camera.position.z,
        this._projTemp
      );
      this._autoWalkDistAlongM = this._projTemp.distanceAlongPathM;
      this._autoWalkStartTimeMs = performance.now();
      this._state = setAutoWalkState(this._state, true);
      this.config.showToast("Auto-walking along route (Key G to stop)");
    } else {
      this.cancelAutoWalk("toggled off");
    }

    this.config.guidanceHUD.update(this._state, this._instTemp);
  }

  /**
   * Cancels auto-walk immediately and teleports player to a valid state.
   */
  cancelAutoWalk(reason = "input"): void {
    if (!this._state.autoWalkActive) return;

    // Grace period for user input: ignore user input cancellation within 350ms of activation
    // to prevent the initiating keydown/keyup or mouse click from immediately cancelling auto-walk
    if (reason === "user input" && performance.now() - this._autoWalkStartTimeMs < 350) {
      return;
    }

    this._state = setAutoWalkState(this._state, false);
    const cam = this.config.camera;
    const yaw = this.config.controls.currentYawRad;

    // Reset controls velocity and head-bob using teleportTo
    this.config.controls.teleportTo(cam.position.x, 1.45, cam.position.z, yaw, 0);
    this.config.guidanceHUD.update(this._state, this._instTemp);
    console.log(`[Navigation] Auto-walk stopped (${reason})`);
  }

  /**
   * Toggles Debug Overlay (Key O).
   */
  toggleDebugOverlay(): void {
    const nextActive = !this._state.debugOverlayActive;
    this._state = setDebugOverlayState(this._state, nextActive);

    const grid = this.config.navGrid();
    if (nextActive && this.isActive() && this._state.targetPOI && grid) {
      // Re-run pathfinding with collectExplored enabled to retrieve explored cells
      const cam = this.config.camera;
      const res = findPath(
        grid,
        { x: cam.position.x, z: cam.position.z },
        { x: this._state.targetPOI.anchor.x, z: this._state.targetPOI.anchor.z },
        {
          playerRadius: 0.08,
          snapStart: true,
          snapGoal: false,
          collectExplored: true,
        }
      );
      if ("points" in res) {
        const s = res as PathSuccess;
        this._state.rawPath = s.rawPoints ?? null;
        this._state.exploredCells = s.exploredCells ?? null;
      }
    }

    this.config.minimap.setDebugOverlay(
      nextActive,
      nextActive ? this._state.rawPath : null,
      nextActive ? this._state.exploredCells : null
    );
    this.config.guidanceHUD.update(this._state, this._instTemp);
    this.config.showToast(`Navigation Debug Overlay: ${nextActive ? "ON" : "OFF"}`);
    console.log(`[Navigation] Debug overlay: ${nextActive ? "ON" : "OFF"}`);
  }

  /**
   * Main per-frame update loop called from tick.
   * ZERO heap allocations.
   */
  update(dt: number, nowMs: number): void {
    if (!this.isActive() || !this._state.path || !this._state.targetPOI) {
      return;
    }

    const cam = this.config.camera;
    const path = this._state.path;
    const targetPOI = this._state.targetPOI;

    // 1. Process Auto-Walk movement along path
    if (this._state.autoWalkActive) {
      this.stepAutoWalk(dt, nowMs);
    }

    // 2. Project player position onto path with monotonic progression
    projectPlayerOnPath(path, cam.position.x, cam.position.z, this._projTemp, this._lastSegIdx);
    this._lastSegIdx = this._projTemp.segmentIndex;

    // 3. Arrival Check (<= 0.6 m from destination anchor)
    const distToAnchor = Math.hypot(
      cam.position.x - targetPOI.anchor.x,
      cam.position.z - targetPOI.anchor.z
    );

    if (distToAnchor <= this._state.arrivalDistanceThresholdM) {
      console.log(`[Navigation] Arrived at "${targetPOI.name}" (dist=${distToAnchor.toFixed(2)}m)`);
      this.config.guidanceHUD.showArrival(targetPOI.name);
      this.clearRoute();
      return;
    }

    // 4. Off-Path Detection (> 0.8 m) and Debounced Re-routing
    if (this._projTemp.distanceOffPathM > this._state.offPathThresholdM) {
      const { canReroute, nextState } = beginReroute(this._state, nowMs);
      this._state = nextState;

      if (canReroute) {
        this.executeReroute(nowMs);
      }
    }

    // 5. Update guidance instructions (relative heading, along-path turn tracking, hysteresis)
    generateInstruction(
      path,
      this._projTemp,
      this._state.totalLengthM,
      targetPOI.name,
      this.config.controls.currentYawRad,
      this._instTemp,
      this._guidanceTracker,
      this._precomputedTurns
    );

    // 5b. Periodic Diagnostic Log (behind explicit debug flag window.__NAV_DEBUG__, every 0.5s)
    const isNavDebugEnabled = typeof window !== "undefined" && (window as any).__NAV_DEBUG__ === true;
    if (this._state.debugOverlayActive && isNavDebugEnabled && nowMs - this._lastDebugLogTimeMs >= 500) {
      this._lastDebugLogTimeMs = nowMs;

      const turns = this._precomputedTurns;
      const activeIdx = this._guidanceTracker.activeTurnIndex;
      const activeTurn = activeIdx < turns.length ? turns[activeIdx] : null;

      const turnPtStr = activeTurn
        ? `(${activeTurn.point.x.toFixed(2)}, ${activeTurn.point.z.toFixed(2)})`
        : "(none)";
      const angleStr = activeTurn
        ? `${activeTurn.angleDeg.toFixed(1)}° (${activeTurn.isLeft ? "left" : "right"})`
        : "0.0° (none)";
      const distAlongTurnStr = activeTurn ? `${activeTurn.alongPathM.toFixed(2)}m` : "0.00m";

      console.log(
        `[NavDebug] player=(${cam.position.x.toFixed(2)}, ${cam.position.z.toFixed(2)}) yaw=${this.config.controls.currentYawDeg.toFixed(1)}° | ` +
        `proj=(${this._projTemp.nearestPoint.x.toFixed(2)}, ${this._projTemp.nearestPoint.z.toFixed(2)}) offPath=${this._projTemp.distanceOffPathM.toFixed(2)}m segIdx=${this._projTemp.segmentIndex} | ` +
        `nextTurn=${turnPtStr} angle=${angleStr} distAlong=${distAlongTurnStr} | ` +
        `text="${this._instTemp.text}"`
      );
    }

    // 6. Update 3D floor route renderer (chevrons distance fade & beacon spin)
    this.config.routeRenderer.update(this._projTemp.distanceAlongPathM, nowMs);

    // 7. Update HUD DOM
    this.config.guidanceHUD.update(this._state, this._instTemp);
  }

  /**
   * Executes automatic debounced re-routing.
   */
  private executeReroute(nowMs: number): void {
    const grid = this.config.navGrid();
    const targetPOI = this._state.targetPOI;
    if (!grid || !targetPOI) return;

    this.config.showToast("Re-routing...");
    const cam = this.config.camera;
    const res = findPath(
      grid,
      { x: cam.position.x, z: cam.position.z },
      { x: targetPOI.anchor.x, z: targetPOI.anchor.z },
      {
        playerRadius: 0.08,
        snapStart: true,
        snapGoal: false,
        collectExplored: this._state.debugOverlayActive,
      }
    );

    if ("error" in res) {
      console.warn(`[Navigation] Re-route failed (${res.error}); keeping previous route`);
      this.config.showToast("Could not find alternative route; keeping current path");
      return;
    }

    const s = res as PathSuccess;
    this._state = applyReroutedPath(
      this._state,
      s.points,
      s.lengthM,
      s.computeMs,
      s.expandedNodes,
      nowMs,
      s.rawPoints,
      s.exploredCells
    );

    this._lastSegIdx = 0;
    this._guidanceTracker.activeTurnIndex = 0;
    this._precomputedTurns = extractTurnEvents(s.points);
    this._autoWalkDistAlongM = 0;

    this.config.routeRenderer.setRoute(s.points, targetPOI.anchor);
    this.config.minimap.setRoute(s.points, targetPOI.anchor);
    this.config.minimap.setDebugOverlay(
      this._state.debugOverlayActive,
      s.rawPoints,
      s.exploredCells
    );

    console.log(
      `[Navigation] Re-routed successfully: length=${s.lengthM.toFixed(
        2
      )}m, nodes=${s.expandedNodes}, time=${s.computeMs.toFixed(2)}ms`
    );
  }

  /**
   * Advances auto-walk camera position along the smoothed path.
   */
  private stepAutoWalk(dt: number, nowMs: number): void {
    const path = this._state.path;
    const targetPOI = this._state.targetPOI;
    if (!path || !targetPOI) return;

    const moveStep = WALK_SPEED_MPS * dt;
    this._autoWalkDistAlongM += moveStep;

    const totalLen = this._state.totalLengthM;
    if (this._autoWalkDistAlongM >= totalLen - 0.05) {
      // Reached destination anchor
      this.cancelAutoWalk("reached destination");
      this.config.controls.teleportTo(
        targetPOI.anchor.x,
        1.45,
        targetPOI.anchor.z,
        this.config.controls.currentYawRad,
        0
      );
      return;
    }

    // Find point on path at distance this._autoWalkDistAlongM
    let targetX = path[path.length - 1].x;
    let targetZ = path[path.length - 1].z;
    let segmentBearingYaw = this.config.controls.currentYawRad;

    let accum = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];
      const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);

      if (accum + segLen >= this._autoWalkDistAlongM) {
        const segDist = this._autoWalkDistAlongM - accum;
        const t = segLen > 1e-6 ? segDist / segLen : 0;
        targetX = p1.x + t * (p2.x - p1.x);
        targetZ = p1.z + t * (p2.z - p1.z);

        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        segmentBearingYaw = Math.atan2(-dx, -dz);
        break;
      }
      accum += segLen;
    }

    // Collision Check: Must not enter blocked cells
    // Player radius is 0.08 m. Discretization error along 0.05m sampled segments
    // can penetrate up to 0.08 - sqrt(0.08^2 - 0.025^2) = 0.004 m near grid cell corners.
    // Using 0.07 m collision radius prevents false-positive halts on valid smoothed paths
    // while strictly preventing entry into actual obstacle cells.
    const occ = this.config.occupancy();
    if (occ && isCircleBlocked(occ, targetX, targetZ, 0.07, false, true)) {
      console.warn(`[Navigation] Auto-walk blocked by collision at (${targetX.toFixed(2)}, ${targetZ.toFixed(2)})`);
      this.cancelAutoWalk("blocked by obstacle");
      this.config.showToast("Auto-walk stopped: obstacle ahead");
      return;
    }

    // Smooth camera yaw interpolation toward waypoint bearing
    const curYaw = this.config.controls.currentYawRad;
    let diff = segmentBearingYaw - curYaw;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    const interpolatedYaw = curYaw + diff * Math.min(1.0, 7.0 * dt);

    // Update camera position at fixed eye height 1.45 m
    this.config.controls.teleportTo(targetX, 1.45, targetZ, interpolatedYaw, 0);
  }
}
