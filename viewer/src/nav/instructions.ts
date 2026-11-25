/**
 * instructions.ts
 * Turn-by-turn navigation instruction generation, monotonic path projection,
 * heading-relative orientation guidance, along-path turn tracking with hysteresis,
 * and distance formatting.
 *
 * Pure TypeScript: NO Three.js and NO DOM imports.
 */

import { NavGridPoint } from "./navgrid";

export const WALK_SPEED_MPS = 1.4; // 1.4 m/s standard walking speed

export type InstructionType =
  | "continue"
  | "turn-face"
  | "turn-around"
  | "turn-left"
  | "turn-right"
  | "turn-sharp-left"
  | "turn-sharp-right"
  | "turn-left-now"
  | "turn-right-now"
  | "arrive"
  | "arrived";

export interface PathProjection {
  nearestPoint: { x: number; z: number };
  distanceOffPathM: number;
  segmentIndex: number;
  segmentT: number;
  distanceAlongPathM: number;
  remainingDistanceM: number;
}

export interface TurnEvent {
  vertexIndex: number;
  point: NavGridPoint;
  alongPathM: number;
  angleDeg: number;
  isLeft: boolean;
  isSharp: boolean;
}

export interface NavigationInstruction {
  type: InstructionType;
  text: string;
  distanceToEventM: number;
  remainingDistanceM: number;
  etaSeconds: number;
  progressFraction: number;
  turnAngleDeg?: number;
  targetVertex?: NavGridPoint;
}

/**
 * Rounds a distance in metres to the nearest 0.5 m.
 * Example: 3.24 -> 3.0, 3.26 -> 3.5, 3.74 -> 3.5, 3.76 -> 4.0.
 */
export function roundToHalf(val: number): number {
  return Math.round(val * 2) / 2;
}

/**
 * Formats a distance in metres rounded to 0.5 m.
 */
export function formatDistance(valM: number): string {
  const rounded = roundToHalf(Math.max(0, valM));
  return `${rounded.toFixed(1)} m`;
}

/**
 * Computes signed turn angle in degrees between vector v1 (dx1, dz1) and vector v2 (dx2, dz2).
 * Coordinate convention: North is -Z, East is +X, South is +Z, West is -X.
 * Yaw convention from controls.ts:
 *   Forward direction from yaw: (-sin(yaw), 0, -cos(yaw)).
 *   Yaw 0 points North (-Z).
 *   Positive yaw turns left (pointing towards -X at +pi/2).
 *   Negative yaw turns right (pointing towards +X at -pi/2).
 *
 * 2D Cross-product in XZ:
 *   cross = dx1 * dz2 - dz1 * dx2
 *   If cross < 0 -> TURN LEFT
 *   If cross > 0 -> TURN RIGHT
 */
export function computeTurnAngleDeg(
  dx1: number,
  dz1: number,
  dx2: number,
  dz2: number
): { angleDeg: number; isLeft: boolean } {
  const len1 = Math.hypot(dx1, dz1);
  const len2 = Math.hypot(dx2, dz2);
  if (len1 < 1e-6 || len2 < 1e-6) {
    return { angleDeg: 0, isLeft: false };
  }

  const cross = dx1 * dz2 - dz1 * dx2;
  const dot = dx1 * dx2 + dz1 * dz2;

  const signedRad = Math.atan2(cross, dot);
  const signedDeg = (signedRad * 180) / Math.PI;

  const isLeft = signedDeg < 0;
  const absDeg = Math.abs(signedDeg);

  return { angleDeg: absDeg, isLeft };
}

/**
 * Computes relative heading difference between the player's current yaw and the route vector.
 *
 * Route direction vector (segDx, segDz) mapped to yaw space:
 *   forward = (-sin(routeYaw), -cos(routeYaw)) = (segDx / len, segDz / len)
 *   routeYaw = atan2(-segDx, -segDz)
 *
 * diff = routeYaw - playerYaw
 * If diff > 0 -> player must turn LEFT (positive yaw) to align with route.
 * If diff < 0 -> player must turn RIGHT (negative yaw) to align with route.
 */
export function computeInitialHeadingDiff(
  playerYawRad: number,
  segDx: number,
  segDz: number
): { diffDeg: number; isTurnAround: boolean; isLeft: boolean; isMisaligned: boolean } {
  const len = Math.hypot(segDx, segDz);
  if (len < 1e-6) {
    return { diffDeg: 0, isTurnAround: false, isLeft: false, isMisaligned: false };
  }

  const routeYaw = Math.atan2(-segDx / len, -segDz / len);
  let diff = routeYaw - playerYawRad;

  while (diff < -Math.PI) diff += Math.PI * 2;
  while (diff > Math.PI) diff -= Math.PI * 2;

  const diffDeg = (diff * 180) / Math.PI;
  const absDiff = Math.abs(diffDeg);

  const isTurnAround = absDiff > 135.0;
  const isMisaligned = absDiff > 45.0;
  const isLeft = diffDeg > 0;

  return { diffDeg, isTurnAround, isLeft, isMisaligned };
}

/**
 * Precomputes cumulative along-path distances for all vertices.
 */
export function precomputePathDistances(points: NavGridPoint[]): {
  cumulativeDistances: number[];
  totalLengthM: number;
} {
  const n = points.length;
  const cumulativeDistances: number[] = new Array(n);
  cumulativeDistances[0] = 0;

  let total = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    total += d;
    cumulativeDistances[i] = total;
  }

  return { cumulativeDistances, totalLengthM: total };
}

/**
 * Extracts significant turn events along the path, merging consecutive small bends.
 * A turn event requires an angular deviation >= 20 degrees.
 */
export function extractTurnEvents(
  points: NavGridPoint[],
  cumulativeDistances?: number[]
): TurnEvent[] {
  const n = points.length;
  if (n < 3) return [];

  const cumDists = cumulativeDistances ?? precomputePathDistances(points).cumulativeDistances;
  const events: TurnEvent[] = [];

  let i = 1;
  while (i < n - 1) {
    const ptPrev = points[i - 1];
    const ptCurr = points[i];
    const ptNext = points[i + 1];

    const dx1 = ptCurr.x - ptPrev.x;
    const dz1 = ptCurr.z - ptPrev.z;
    const dx2 = ptNext.x - ptCurr.x;
    const dz2 = ptNext.z - ptCurr.z;

    let { angleDeg, isLeft } = computeTurnAngleDeg(dx1, dz1, dx2, dz2);
    let lastMergedIdx = i;

    // Merge consecutive small bends within 1.5 m turning in the same direction
    let lookAhead = i + 1;
    while (lookAhead < n - 1) {
      const distFromStart = cumDists[lookAhead] - cumDists[i];
      if (distFromStart > 1.5) break;

      const ptLookNext = points[lookAhead + 1];
      const lookDx2 = ptLookNext.x - points[lookAhead].x;
      const lookDz2 = ptLookNext.z - points[lookAhead].z;
      const stepAngle = computeTurnAngleDeg(
        points[lookAhead].x - points[lookAhead - 1].x,
        points[lookAhead].z - points[lookAhead - 1].z,
        lookDx2,
        lookDz2
      );

      if (stepAngle.isLeft === isLeft || angleDeg < 20.0) {
        const combinedDx2 = ptLookNext.x - ptCurr.x;
        const combinedDz2 = ptLookNext.z - ptCurr.z;
        const combined = computeTurnAngleDeg(dx1, dz1, combinedDx2, combinedDz2);
        if (combined.angleDeg > angleDeg) {
          angleDeg = combined.angleDeg;
          isLeft = combined.isLeft;
          lastMergedIdx = lookAhead;
        }
      }
      lookAhead++;
    }

    if (angleDeg >= 20.0) {
      events.push({
        vertexIndex: i,
        point: ptCurr,
        alongPathM: cumDists[i],
        angleDeg,
        isLeft,
        isSharp: angleDeg > 70.0,
      });
      i = lastMergedIdx + 1;
    } else {
      i++;
    }
  }

  return events;
}

/**
 * Projects player position onto path with monotonic segment progression.
 * Guarantees that segment index never decreases by more than 1 segment, preventing jitter jumps.
 * Reuses `out` object for ZERO heap allocation per frame.
 */
export function projectPlayerOnPath(
  points: NavGridPoint[],
  px: number,
  pz: number,
  out?: PathProjection,
  lastSegmentIndex?: number
): PathProjection {
  const res: PathProjection = out ?? {
    nearestPoint: { x: 0, z: 0 },
    distanceOffPathM: 0,
    segmentIndex: 0,
    segmentT: 0,
    distanceAlongPathM: 0,
    remainingDistanceM: 0,
  };

  const n = points.length;
  if (n === 0) {
    res.nearestPoint.x = px;
    res.nearestPoint.z = pz;
    res.distanceOffPathM = 0;
    res.segmentIndex = 0;
    res.segmentT = 0;
    res.distanceAlongPathM = 0;
    res.remainingDistanceM = 0;
    return res;
  }

  if (n === 1) {
    res.nearestPoint.x = points[0].x;
    res.nearestPoint.z = points[0].z;
    res.distanceOffPathM = Math.hypot(px - points[0].x, pz - points[0].z);
    res.segmentIndex = 0;
    res.segmentT = 0;
    res.distanceAlongPathM = 0;
    res.remainingDistanceM = 0;
    return res;
  }

  // Monotonic restriction: never search backwards by more than 1 segment
  const minSeg = lastSegmentIndex !== undefined && lastSegmentIndex >= 0
    ? Math.max(0, lastSegmentIndex - 1)
    : 0;

  let minSqDist = Infinity;
  let bestSeg = minSeg;
  let bestT = 0;
  let bestQx = points[minSeg].x;
  let bestQz = points[minSeg].z;

  for (let i = minSeg; i < n - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const vx = p2.x - p1.x;
    const vz = p2.z - p1.z;
    const lenSq = vx * vx + vz * vz;

    let t = 0;
    if (lenSq > 1e-12) {
      t = ((px - p1.x) * vx + (pz - p1.z) * vz) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }

    const qx = p1.x + t * vx;
    const qz = p1.z + t * vz;
    const sqDist = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);

    if (sqDist < minSqDist) {
      minSqDist = sqDist;
      bestSeg = i;
      bestT = t;
      bestQx = qx;
      bestQz = qz;
    }
  }

  // Compute along-path distance
  let distAlong = 0;
  for (let i = 0; i < bestSeg; i++) {
    distAlong += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  const curSegLen = Math.hypot(
    points[bestSeg + 1].x - points[bestSeg].x,
    points[bestSeg + 1].z - points[bestSeg].z
  );
  distAlong += bestT * curSegLen;

  let totalLen = distAlong + (1.0 - bestT) * curSegLen;
  for (let i = bestSeg + 1; i < n - 1; i++) {
    totalLen += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }

  res.nearestPoint.x = bestQx;
  res.nearestPoint.z = bestQz;
  res.distanceOffPathM = Math.sqrt(minSqDist);
  res.segmentIndex = bestSeg;
  res.segmentT = bestT;
  res.distanceAlongPathM = distAlong;
  res.remainingDistanceM = Math.max(0, totalLen - distAlong);

  return res;
}

/**
 * State tracker to manage hysteresis across frames without heap allocation.
 */
export interface GuidanceStateTracker {
  activeTurnIndex: number;
  initialHeadingResolved: boolean;
}

/**
 * Generates turn-by-turn guidance instruction.
 *
 * Fixes:
 *  1. First instruction relative to player's current yaw:
 *     - If angle > 135 deg: "Turn around".
 *     - If angle > 45 deg: "Turn left/right to face the route".
 *     - Otherwise: "Continue N m".
 *  2. Turn distance = (along-path distance of turn vertex) - (player projected distance).
 *     - Clamped at 0, rounded to 0.5 m.
 *     - When under 1 m: "Turn left/right now".
 *     - No "in 0.0 m" instructions ever emitted.
 *  3. Hysteresis: switch to next turn only when along-path distance exceeds turn vertex by 0.3 m.
 *  4. Single arrival instruction:
 *     - Approaching destination (> 0.6 m): "Arrive in N m".
 *     - Within 0.6 m: exactly one "Arrive at <name>".
 */
export function generateInstruction(
  points: NavGridPoint[],
  projection: PathProjection,
  totalPathLengthM: number,
  poiName?: string,
  playerYawRad?: number,
  out?: NavigationInstruction,
  tracker?: GuidanceStateTracker,
  precomputedTurns?: TurnEvent[]
): NavigationInstruction {
  const res: NavigationInstruction = out ?? {
    type: "continue",
    text: "",
    distanceToEventM: 0,
    remainingDistanceM: 0,
    etaSeconds: 0,
    progressFraction: 0,
  };

  const remainingM = projection.remainingDistanceM;
  const etaSec = Math.round(remainingM / WALK_SPEED_MPS);
  const progress = totalPathLengthM > 0
    ? Math.min(1.0, Math.max(0.0, projection.distanceAlongPathM / totalPathLengthM))
    : 1.0;

  res.remainingDistanceM = remainingM;
  res.etaSeconds = etaSec;
  res.progressFraction = progress;

  // 1. ARRIVAL: Within 0.6 m of destination anchor (with floating-point tolerance)
  if (remainingM <= 0.6 + 1e-5) {
    res.type = "arrive";
    res.distanceToEventM = 0;
    res.text = poiName ? `Arrive at ${poiName}` : `Arrive in 0.5 m`;
    return res;
  }

  const numPoints = points.length;
  if (numPoints < 2) {
    res.type = "arrive";
    res.distanceToEventM = remainingM;
    res.text = `Arrive in ${formatDistance(remainingM)}`;
    return res;
  }

  const distAlong = projection.distanceAlongPathM;

  // 2. INITIAL HEADING ORIENTATION CHECK
  if (playerYawRad !== undefined && projection.segmentIndex === 0 && distAlong < 0.6) {
    const isAlreadyResolved = tracker?.initialHeadingResolved === true;
    const thresholdDeg = isAlreadyResolved ? 55.0 : 45.0; // 10 deg hysteresis

    const p0 = points[0];
    const p1 = points[1];
    const heading = computeInitialHeadingDiff(playerYawRad, p1.x - p0.x, p1.z - p0.z);

    if (heading.isTurnAround) {
      if (tracker) tracker.initialHeadingResolved = false;
      res.type = "turn-around";
      res.distanceToEventM = 0;
      res.text = "Turn around";
      return res;
    }

    if (Math.abs(heading.diffDeg) > thresholdDeg) {
      if (tracker) tracker.initialHeadingResolved = false;
      res.type = "turn-face";
      res.distanceToEventM = 0;
      res.text = heading.isLeft ? "Turn left to face the route" : "Turn right to face the route";
      return res;
    }

    if (tracker) {
      tracker.initialHeadingResolved = true;
    }

    // Player is facing route: "Otherwise Continue N m"
    if (distAlong < 0.5) {
      const turns = precomputedTurns ?? extractTurnEvents(points);
      const firstTurn = turns.length > 0 ? turns[0] : null;
      const distToEvent = firstTurn ? Math.max(0.5, firstTurn.alongPathM - distAlong) : remainingM;

      res.type = "continue";
      res.distanceToEventM = distToEvent;
      res.text = `Continue ${formatDistance(distToEvent)}`;
      return res;
    }
  }

  // 3. RETRIEVE OR EXTRACT SIGNIFICANT TURNS
  const turns = precomputedTurns ?? extractTurnEvents(points);

  // 4. FIND ACTIVE TURN WITH 0.3 m HYSTERESIS
  let activeTurn: TurnEvent | null = null;
  let activeIdx = tracker ? tracker.activeTurnIndex : 0;

  while (activeIdx < turns.length) {
    const t = turns[activeIdx];
    // Switch to next turn only when player along-path distance passes vertex by 0.3 m
    if (distAlong < t.alongPathM + 0.3) {
      activeTurn = t;
      break;
    }
    activeIdx++;
  }

  if (tracker) {
    tracker.activeTurnIndex = activeIdx;
  }

  // 5. IF AN ACTIVE TURN EXISTS
  if (activeTurn) {
    const distToVertex = Math.max(0, activeTurn.alongPathM - distAlong);
    res.distanceToEventM = distToVertex;
    res.turnAngleDeg = activeTurn.angleDeg;
    res.targetVertex = activeTurn.point;

    const dirWord = activeTurn.isLeft ? "left" : "right";
    const sharpWord = activeTurn.isSharp ? "sharply " : "";

    // When under 1.0 m: say "Turn left/right now"
    if (distToVertex < 1.0) {
      res.type = activeTurn.isLeft ? "turn-left-now" : "turn-right-now";
      res.text = `Turn ${sharpWord}${dirWord} now`;
      return res;
    }

    // When >= 1.0 m: say "Turn left/right in N m"
    res.type = activeTurn.isSharp
      ? (activeTurn.isLeft ? "turn-sharp-left" : "turn-sharp-right")
      : (activeTurn.isLeft ? "turn-left" : "turn-right");

    res.text = `Turn ${sharpWord}${dirWord} in ${formatDistance(distToVertex)}`;
    return res;
  }

  // 6. NO ACTIVE TURNS REMAINING
  // If approaching destination (final segment or remaining distance <= 3.0 m), say "Arrive in N m"
  // Otherwise, if still on an intermediate straight stretch, say "Continue N m"
  const isFinalApproach = projection.segmentIndex >= numPoints - 2 || remainingM <= 3.0;

  if (isFinalApproach) {
    res.type = "arrive";
    res.distanceToEventM = remainingM;
    res.text = `Arrive in ${formatDistance(remainingM)}`;
    return res;
  }

  res.type = "continue";
  res.distanceToEventM = remainingM;
  res.text = `Continue ${formatDistance(remainingM)}`;
  return res;
}
