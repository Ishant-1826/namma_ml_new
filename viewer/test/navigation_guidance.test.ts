import { describe, it, expect } from "vitest";
import {
  createInitialRouteState,
  selectPOIDestination,
  startNavigationRoute,
  beginReroute,
  applyReroutedPath,
  checkArrivalState,
  clearActiveRoute,
  setAutoWalkState,
  setDebugOverlayState,
} from "../src/nav/route_state";
import {
  computeTurnAngleDeg,
  roundToHalf,
  formatDistance,
  projectPlayerOnPath,
  generateInstruction,
  WALK_SPEED_MPS,
  PathProjection,
} from "../src/nav/instructions";
import { POI } from "../src/poi/poi_types";
import { NavGridPoint } from "../src/nav/navgrid";

const mockPOI: POI = {
  id: "poi_test_1",
  name: "Study Table",
  category: "table",
  position: { x: 2.0, z: 3.0 },
  anchor: { x: 1.5, z: 2.5 },
};

describe("Phase 5 Navigation Guidance Pure Logic", () => {
  describe("1. Route State Machine Transitions", () => {
    it("starts in idle state with clean default values", () => {
      const state = createInitialRouteState();
      expect(state.status).toBe("idle");
      expect(state.targetPOI).toBeNull();
      expect(state.path).toBeNull();
      expect(state.totalLengthM).toBe(0);
      expect(state.autoWalkActive).toBe(false);
      expect(state.debugOverlayActive).toBe(false);
      expect(state.arrivalDistanceThresholdM).toBe(0.6);
      expect(state.offPathThresholdM).toBe(0.8);
    });

    it("transitions idle -> selected when destination is selected", () => {
      const initial = createInitialRouteState();
      const selected = selectPOIDestination(initial, mockPOI);
      expect(selected.status).toBe("selected");
      expect(selected.targetPOI).toEqual(mockPOI);
      expect(selected.path).toBeNull();
    });

    it("transitions selected -> navigating when path is set", () => {
      const initial = createInitialRouteState();
      const selected = selectPOIDestination(initial, mockPOI);
      const path: NavGridPoint[] = [
        { x: 0, z: 0 },
        { x: 1.5, z: 2.5 },
      ];
      const nav = startNavigationRoute(selected, mockPOI, path, 5.0, 1.2, 42);
      expect(nav.status).toBe("navigating");
      expect(nav.targetPOI?.name).toBe("Study Table");
      expect(nav.path?.length).toBe(2);
      expect(nav.totalLengthM).toBe(5.0);
      expect(nav.computeMs).toBe(1.2);
      expect(nav.expandedNodes).toBe(42);
    });

    it("debounces rerouting to at most 2 per second (500 ms minimum interval)", () => {
      const initial = createInitialRouteState();
      const path: NavGridPoint[] = [{ x: 0, z: 0 }, { x: 2, z: 2 }];
      const nav = startNavigationRoute(initial, mockPOI, path, 2.82, 0.5, 10);
      const t0 = nav.lastRerouteTimeMs;

      // Immediately after start (t0 + 200 ms): reroute should be rejected
      const attempt1 = beginReroute(nav, t0 + 200);
      expect(attempt1.canReroute).toBe(false);
      expect(attempt1.nextState.status).toBe("navigating");

      // After 501 ms: reroute is allowed
      const attempt2 = beginReroute(nav, t0 + 501);
      expect(attempt2.canReroute).toBe(true);
      expect(attempt2.nextState.status).toBe("rerouting");
      expect(attempt2.nextState.lastRerouteTimeMs).toBe(t0 + 501);

      // Successfully applying rerouted path transitions back to navigating
      const newPath: NavGridPoint[] = [{ x: 0.5, z: 0.5 }, { x: 2, z: 2 }];
      const rerouted = applyReroutedPath(attempt2.nextState, newPath, 2.12, 0.4, 8, t0 + 520);
      expect(rerouted.status).toBe("navigating");
      expect(rerouted.totalLengthM).toBe(2.12);
    });

    it("transitions navigating -> arrived when distance to anchor <= 0.6 m", () => {
      const initial = createInitialRouteState();
      const path: NavGridPoint[] = [{ x: 0, z: 0 }, { x: 1.5, z: 2.5 }];
      const nav = startNavigationRoute(initial, mockPOI, path, 3.0, 1.0, 20);

      // At 0.8 m: still navigating
      const stateFar = checkArrivalState(nav, 0.8);
      expect(stateFar.status).toBe("navigating");

      // At exactly 0.6 m: arrived
      const stateArriveBoundary = checkArrivalState(nav, 0.6);
      expect(stateArriveBoundary.status).toBe("arrived");

      // Within 0.3 m: arrived
      const stateArrivedClose = checkArrivalState(nav, 0.3);
      expect(stateArrivedClose.status).toBe("arrived");
      expect(stateArrivedClose.autoWalkActive).toBe(false);
    });

    it("clearActiveRoute resets to idle and stops auto-walk", () => {
      let state = createInitialRouteState();
      state = startNavigationRoute(state, mockPOI, [{ x: 0, z: 0 }, { x: 1, z: 1 }], 1.41, 0.5, 5);
      state = setAutoWalkState(state, true);
      expect(state.autoWalkActive).toBe(true);

      const cleared = clearActiveRoute(state);
      expect(cleared.status).toBe("idle");
      expect(cleared.targetPOI).toBeNull();
      expect(cleared.path).toBeNull();
      expect(cleared.autoWalkActive).toBe(false);
    });

    it("toggles debug overlay state cleanly", () => {
      const state = createInitialRouteState();
      const debugOn = setDebugOverlayState(state, true);
      expect(debugOn.debugOverlayActive).toBe(true);
      const debugOff = setDebugOverlayState(debugOn, false);
      expect(debugOff.debugOverlayActive).toBe(false);
    });
  });

  describe("2. Left/Right Turn Sign and Yaw Convention Correctness", () => {
    // In viewer/controls:
    // North is -Z, East is +X, South is +Z, West is -X.
    // Yaw 0 points North (-Z).
    // Positive yaw turns left (-X). Negative yaw turns right (+X).

    it("North (-Z): turning West (-X) is a 90 deg LEFT turn", () => {
      // Walking North: dx=0, dz=-1
      // Turning West:  dx=-1, dz=0
      const { angleDeg, isLeft } = computeTurnAngleDeg(0, -1, -1, 0);
      expect(angleDeg).toBeCloseTo(90, 1);
      expect(isLeft).toBe(true);
    });

    it("North (-Z): turning East (+X) is a 90 deg RIGHT turn", () => {
      // Walking North: dx=0, dz=-1
      // Turning East:  dx=1, dz=0
      const { angleDeg, isLeft } = computeTurnAngleDeg(0, -1, 1, 0);
      expect(angleDeg).toBeCloseTo(90, 1);
      expect(isLeft).toBe(false);
    });

    it("South (+Z): turning West (-X) is a 90 deg RIGHT turn", () => {
      // Walking South: dx=0, dz=1
      // Turning West:  dx=-1, dz=0
      const { angleDeg, isLeft } = computeTurnAngleDeg(0, 1, -1, 0);
      expect(angleDeg).toBeCloseTo(90, 1);
      expect(isLeft).toBe(false);
    });

    it("South (+Z): turning East (+X) is a 90 deg LEFT turn", () => {
      // Walking South: dx=0, dz=1
      // Turning East:  dx=1, dz=0
      const { angleDeg, isLeft } = computeTurnAngleDeg(0, 1, 1, 0);
      expect(angleDeg).toBeCloseTo(90, 1);
      expect(isLeft).toBe(true);
    });

    it("East (+X): turning North (-Z) is a 90 deg LEFT turn", () => {
      // Walking East: dx=1, dz=0
      // Turning North: dx=0, dz=-1
      const { angleDeg, isLeft } = computeTurnAngleDeg(1, 0, 0, -1);
      expect(angleDeg).toBeCloseTo(90, 1);
      expect(isLeft).toBe(true);
    });

    it("East (+X): turning South (+Z) is a 90 deg RIGHT turn", () => {
      // Walking East: dx=1, dz=0
      // Turning South: dx=0, dz=1
      const { angleDeg, isLeft } = computeTurnAngleDeg(1, 0, 0, 1);
      expect(angleDeg).toBeCloseTo(90, 1);
      expect(isLeft).toBe(false);
    });

    it("West (-X): turning North (-Z) is a 90 deg RIGHT turn", () => {
      // Walking West: dx=-1, dz=0
      // Turning North: dx=0, dz=-1
      const { angleDeg, isLeft } = computeTurnAngleDeg(-1, 0, 0, -1);
      expect(angleDeg).toBeCloseTo(90, 1);
      expect(isLeft).toBe(false);
    });

    it("West (-X): turning South (+Z) is a 90 deg LEFT turn", () => {
      // Walking West: dx=-1, dz=0
      // Turning South: dx=0, dz=1
      const { angleDeg, isLeft } = computeTurnAngleDeg(-1, 0, 0, 1);
      expect(angleDeg).toBeCloseTo(90, 1);
      expect(isLeft).toBe(true);
    });
  });

  describe("3. Distance Formatting and Rounding to 0.5 m", () => {
    it("rounds numbers to nearest 0.5 m correctly", () => {
      expect(roundToHalf(0.1)).toBe(0.0);
      expect(roundToHalf(0.24)).toBe(0.0);
      expect(roundToHalf(0.26)).toBe(0.5);
      expect(roundToHalf(3.24)).toBe(3.0);
      expect(roundToHalf(3.26)).toBe(3.5);
      expect(roundToHalf(3.74)).toBe(3.5);
      expect(roundToHalf(3.76)).toBe(4.0);
      expect(roundToHalf(11.49)).toBe(11.5);
      expect(roundToHalf(11.51)).toBe(11.5);
      expect(roundToHalf(11.76)).toBe(12.0);
    });

    it("formats distances to 0.5 m with unit", () => {
      expect(formatDistance(3.24)).toBe("3.0 m");
      expect(formatDistance(3.26)).toBe("3.5 m");
      expect(formatDistance(10.0)).toBe("10.0 m");
    });
  });

  describe("4. Path Projection and Off-Path Detection", () => {
    const points: NavGridPoint[] = [
      { x: 0, z: 0 },
      { x: 0, z: -10 }, // 10 m North
      { x: 5, z: -10 }, // 5 m East
    ];

    it("projects player onto first segment and measures distance along path", () => {
      // Player is at (0.2, -4.0): offset 0.2 m off path, 4 m along path
      const proj = projectPlayerOnPath(points, 0.2, -4.0);
      expect(proj.distanceOffPathM).toBeCloseTo(0.2, 3);
      expect(proj.distanceAlongPathM).toBeCloseTo(4.0, 3);
      expect(proj.remainingDistanceM).toBeCloseTo(11.0, 3); // 15 - 4 = 11 m
      expect(proj.segmentIndex).toBe(0);
      expect(proj.segmentT).toBeCloseTo(0.4, 3);
    });

    it("detects off-path condition when player is > 0.8 m off path", () => {
      // Player at (0.85, -4.0) -> distance off path is 0.85 m (> 0.8 m threshold)
      const proj = projectPlayerOnPath(points, 0.85, -4.0);
      expect(proj.distanceOffPathM).toBeGreaterThan(0.8);

      // Player at (0.5, -4.0) -> distance off path is 0.5 m (<= 0.8 m)
      const proj2 = projectPlayerOnPath(points, 0.5, -4.0);
      expect(proj2.distanceOffPathM).toBeLessThanOrEqual(0.8);
    });

    it("reuses out object to guarantee zero heap allocation per call", () => {
      const outObj: PathProjection = {
        nearestPoint: { x: 0, z: 0 },
        distanceOffPathM: 0,
        segmentIndex: 0,
        segmentT: 0,
        distanceAlongPathM: 0,
        remainingDistanceM: 0,
      };

      const result = projectPlayerOnPath(points, 1.0, -2.0, outObj);
      expect(result).toBe(outObj); // Exact same object reference!
      expect(outObj.distanceOffPathM).toBeCloseTo(1.0, 3);
      expect(outObj.distanceAlongPathM).toBeCloseTo(2.0, 3);
    });
  });

  describe("5. Instruction Generation and Angle Thresholds", () => {
    // 3 segments:
    // Seg 0: (0, 0) -> (0, -10)  (10 m North)
    // Seg 1: (0, -10) -> (5, -10) (5 m East, 90 deg RIGHT turn)
    // Seg 2: (5, -10) -> (8, -13) (4.24 m NE, 45 deg LEFT turn)
    const points: NavGridPoint[] = [
      { x: 0, z: 0 },
      { x: 0, z: -10 },
      { x: 5, z: -10 },
      { x: 8, z: -13 },
    ];
    const totalLen = 10 + 5 + Math.hypot(3, -3);

    it("generates 'Turn sharply right in N m' for a 90 degree turn", () => {
      const proj: PathProjection = {
        nearestPoint: { x: 0, z: -6 },
        distanceOffPathM: 0,
        segmentIndex: 0,
        segmentT: 0.6,
        distanceAlongPathM: 6.0,
        remainingDistanceM: totalLen - 6.0,
      };

      const inst = generateInstruction(points, proj, totalLen, "Bench");
      // Turn at (0, -10) is 4.0 m ahead
      expect(inst.type).toBe("turn-sharp-right");
      expect(inst.text).toBe("Turn sharply right in 4.0 m");
      expect(inst.etaSeconds).toBe(Math.round((totalLen - 6.0) / WALK_SPEED_MPS));
      expect(inst.progressFraction).toBeCloseTo(6.0 / totalLen, 2);
    });

    it("generates 'Turn left in N m' for a 45 degree turn (between 20 and 70 deg)", () => {
      // On segment 1: (0, -10) -> (5, -10). Player at (2, -10).
      // Vector 1 is East (1, 0). Vector 2 is (3, -3) normalized (0.707, -0.707).
      // Turn from East to North-East is 45 deg LEFT.
      const proj: PathProjection = {
        nearestPoint: { x: 2, z: -10 },
        distanceOffPathM: 0,
        segmentIndex: 1,
        segmentT: 0.4,
        distanceAlongPathM: 12.0,
        remainingDistanceM: totalLen - 12.0,
      };

      const inst = generateInstruction(points, proj, totalLen, "Bench");
      // Turn at (5, -10) is 3.0 m ahead
      expect(inst.type).toBe("turn-left");
      expect(inst.text).toBe("Turn left in 3.0 m");
    });

    it("generates 'Continue N m' when upcoming angle is under 20 degrees", () => {
      // Route with slight 10 degree bend:
      // (0, 0) -> (0, -5) -> (-0.5, -10) -> destination
      // Angle between (0, -5) and (-0.5, -5) is atan2(0.5, 5) ~ 5.7 degrees (< 20 deg)
      const straightishPoints: NavGridPoint[] = [
        { x: 0, z: 0 },
        { x: 0, z: -5 },
        { x: -0.5, z: -10 },
      ];
      const len = 5 + Math.hypot(-0.5, -5);

      const proj: PathProjection = {
        nearestPoint: { x: 0, z: -1 },
        distanceOffPathM: 0,
        segmentIndex: 0,
        segmentT: 0.2,
        distanceAlongPathM: 1.0,
        remainingDistanceM: len - 1.0,
      };

      const inst = generateInstruction(straightishPoints, proj, len, "Door");
      expect(inst.type).toBe("continue");
      expect(inst.text).toMatch(/^Continue \d+(\.\d)? m$/);
    });

    it("generates 'Arrive in N m' on the final segment leading to anchor", () => {
      const finalSegLen = Math.hypot(3, -3); // ~4.24 m
      const proj: PathProjection = {
        nearestPoint: { x: 6.5, z: -11.5 },
        distanceOffPathM: 0,
        segmentIndex: 2,
        segmentT: 0.5,
        distanceAlongPathM: 15.0 + finalSegLen * 0.5,
        remainingDistanceM: finalSegLen * 0.5, // ~2.12 m
      };

      const inst = generateInstruction(points, proj, totalLen, "Bench");
      expect(inst.type).toBe("arrive");
      expect(inst.text).toBe("Arrive in 2.0 m");
    });

    it("reports arrival when remaining distance <= 0.6 m", () => {
      const proj: PathProjection = {
        nearestPoint: { x: 7.8, z: -12.8 },
        distanceOffPathM: 0,
        segmentIndex: 2,
        segmentT: 0.95,
        distanceAlongPathM: totalLen - 0.4,
        remainingDistanceM: 0.4, // <= 0.6 m
      };

      const inst = generateInstruction(points, proj, totalLen, "Bench");
      expect(inst.type).toBe("arrive");
      expect(inst.text).toBe("Arrive at Bench");
    });
  });
});
