/**
 * route_state.ts
 * Pure TypeScript navigation state machine for POI route guidance.
 * States: idle -> selected -> navigating -> arrived (plus reroute handling).
 * Pure functions only: NO Three.js and NO DOM imports.
 */

import { POI } from "../poi/poi_types";
import { NavGridPoint } from "./navgrid";

export type RouteStatus = "idle" | "selected" | "navigating" | "rerouting" | "arrived";

export interface ExploredCell {
  col: number;
  row: number;
}

export interface RouteState {
  status: RouteStatus;
  targetPOI: POI | null;
  path: NavGridPoint[] | null;
  rawPath: NavGridPoint[] | null;
  exploredCells: ExploredCell[] | null;
  totalLengthM: number;
  computeMs: number;
  expandedNodes: number;
  lastRerouteTimeMs: number;
  arrivalDistanceThresholdM: number;
  offPathThresholdM: number;
  minRerouteIntervalMs: number;
  autoWalkActive: boolean;
  debugOverlayActive: boolean;
}

/**
 * Creates a clean initial idle route state.
 */
export function createInitialRouteState(): RouteState {
  return {
    status: "idle",
    targetPOI: null,
    path: null,
    rawPath: null,
    exploredCells: null,
    totalLengthM: 0,
    computeMs: 0,
    expandedNodes: 0,
    lastRerouteTimeMs: 0,
    arrivalDistanceThresholdM: 0.6,
    offPathThresholdM: 0.8,
    minRerouteIntervalMs: 500, // 2 reroutes per second limit
    autoWalkActive: false,
    debugOverlayActive: false,
  };
}

/**
 * Transition: Select a target POI without starting navigation yet (idle -> selected).
 */
export function selectPOIDestination(state: RouteState, poi: POI): RouteState {
  return {
    ...state,
    status: "selected",
    targetPOI: poi,
    path: null,
    rawPath: null,
    exploredCells: null,
    totalLengthM: 0,
    computeMs: 0,
    expandedNodes: 0,
    autoWalkActive: false,
  };
}

/**
 * Transition: Begin navigating along a computed path (selected/idle -> navigating).
 */
export function startNavigationRoute(
  state: RouteState,
  targetPOI: POI,
  path: NavGridPoint[],
  totalLengthM: number,
  computeMs: number,
  expandedNodes: number,
  rawPath?: NavGridPoint[] | null,
  exploredCells?: ExploredCell[] | null
): RouteState {
  return {
    ...state,
    status: "navigating",
    targetPOI,
    path,
    rawPath: rawPath ?? null,
    exploredCells: exploredCells ?? null,
    totalLengthM,
    computeMs,
    expandedNodes,
    lastRerouteTimeMs: performance.now(),
  };
}

/**
 * Checks if enough time has elapsed to trigger a reroute (debounce <= 2/sec).
 */
export function canTriggerReroute(state: RouteState, nowMs: number): boolean {
  if (state.status !== "navigating" && state.status !== "rerouting") {
    return false;
  }
  return nowMs - state.lastRerouteTimeMs >= state.minRerouteIntervalMs;
}

/**
 * Transition: Mark state as rerouting if debounced window has passed.
 */
export function beginReroute(
  state: RouteState,
  nowMs: number
): { canReroute: boolean; nextState: RouteState } {
  if (!canTriggerReroute(state, nowMs)) {
    return { canReroute: false, nextState: state };
  }
  return {
    canReroute: true,
    nextState: {
      ...state,
      status: "rerouting",
      lastRerouteTimeMs: nowMs,
    },
  };
}

/**
 * Transition: Update path after successful reroute.
 */
export function applyReroutedPath(
  state: RouteState,
  path: NavGridPoint[],
  totalLengthM: number,
  computeMs: number,
  expandedNodes: number,
  nowMs: number,
  rawPath?: NavGridPoint[] | null,
  exploredCells?: ExploredCell[] | null
): RouteState {
  return {
    ...state,
    status: "navigating",
    path,
    rawPath: rawPath ?? null,
    exploredCells: exploredCells ?? null,
    totalLengthM,
    computeMs,
    expandedNodes,
    lastRerouteTimeMs: nowMs,
  };
}

/**
 * Transition: Checks if the player is within arrival distance (<= 0.6 m from anchor).
 */
export function checkArrivalState(
  state: RouteState,
  distanceToAnchorM: number
): RouteState {
  if (state.status !== "navigating" && state.status !== "rerouting") {
    return state;
  }
  if (distanceToAnchorM <= state.arrivalDistanceThresholdM) {
    return {
      ...state,
      status: "arrived",
      autoWalkActive: false,
    };
  }
  return state;
}

/**
 * Transition: Clears active navigation and returns to idle.
 */
export function clearActiveRoute(state: RouteState): RouteState {
  return {
    ...state,
    status: "idle",
    targetPOI: null,
    path: null,
    rawPath: null,
    exploredCells: null,
    totalLengthM: 0,
    computeMs: 0,
    expandedNodes: 0,
    autoWalkActive: false,
  };
}

/**
 * Toggles or sets auto-walk state.
 */
export function setAutoWalkState(state: RouteState, active: boolean): RouteState {
  return {
    ...state,
    autoWalkActive: active,
  };
}

/**
 * Toggles or sets debug overlay state.
 */
export function setDebugOverlayState(state: RouteState, active: boolean): RouteState {
  return {
    ...state,
    debugOverlayActive: active,
  };
}
