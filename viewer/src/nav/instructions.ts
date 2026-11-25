/**
 * instructions.ts
 * Navigation instruction generation, path projection, and distance formatting.
 * Pure TypeScript: NO Three.js and NO DOM imports.
 */

import { NavGridPoint } from "./navgrid";

export const WALK_SPEED_MPS = 1.4; // 1.4 m/s standard walking speed

export type InstructionType =
  | "continue"
  | "turn-left"
  | "turn-right"
  | "turn-sharp-left"
  | "turn-sharp-right"
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

export interface NavigationInstruction {
  type: InstructionType;
  text: string;
  distanceToEventM: number;
  remainingDistanceM: number;
  etaSeconds: number;
  progressFraction: number;
  turnAngleDeg?: number;
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
 *   Positive yaw turns left (pointing towards -X).
 *   Negative yaw turns right (pointing towards +X).
 * Cross-product in XZ:
 *   cross = dx1 * dz2 - dz1 * dx2
 *   If cross < 0 -> TURN LEFT (negative angle, -180 to 0)
 *   If cross > 0 -> TURN RIGHT (positive angle, 0 to 180)
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

  // 2D cross product and dot product in XZ plane
  const cross = dx1 * dz2 - dz1 * dx2;
  const dot = dx1 * dx2 + dz1 * dz2;

  // Signed angle in radians: [-PI, +PI]
  const signedRad = Math.atan2(cross, dot);
  const signedDeg = (signedRad * 180) / Math.PI;

  const isLeft = signedDeg < 0;
  const absDeg = Math.abs(signedDeg);

  return { angleDeg: absDeg, isLeft };
}

/**
 * Calculates total cumulative length of a polyline in metres.
 */
export function computePathLengthM(points: NavGridPoint[]): number {
  if (points.length < 2) return 0;
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) {
    len += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return len;
}

/**
 * Projects player position (px, pz) onto the polyline.
 * Computes nearest point, distance off path, segment index, segment t,
 * distance along path, and remaining distance to path end.
 *
 * Reuses the passed `out` object to guarantee ZERO heap allocations during render loop calls.
 */
export function projectPlayerOnPath(
  points: NavGridPoint[],
  px: number,
  pz: number,
  out?: PathProjection
): PathProjection {
  const res: PathProjection = out ?? {
    nearestPoint: { x: 0, z: 0 },
    distanceOffPathM: 0,
    segmentIndex: 0,
    segmentT: 0,
    distanceAlongPathM: 0,
    remainingDistanceM: 0,
  };

  if (points.length === 0) {
    res.nearestPoint.x = px;
    res.nearestPoint.z = pz;
    res.distanceOffPathM = 0;
    res.segmentIndex = 0;
    res.segmentT = 0;
    res.distanceAlongPathM = 0;
    res.remainingDistanceM = 0;
    return res;
  }

  if (points.length === 1) {
    res.nearestPoint.x = points[0].x;
    res.nearestPoint.z = points[0].z;
    res.distanceOffPathM = Math.hypot(px - points[0].x, pz - points[0].z);
    res.segmentIndex = 0;
    res.segmentT = 0;
    res.distanceAlongPathM = 0;
    res.remainingDistanceM = 0;
    return res;
  }

  let minSqDist = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  let bestQx = points[0].x;
  let bestQz = points[0].z;

  // Find closest segment and projection point
  for (let i = 0; i < points.length - 1; i++) {
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

  // Calculate cumulative distance along path up to projection point
  let distAlong = 0;
  for (let i = 0; i < bestSeg; i++) {
    distAlong += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  const curSegLen = Math.hypot(
    points[bestSeg + 1].x - points[bestSeg].x,
    points[bestSeg + 1].z - points[bestSeg].z
  );
  distAlong += bestT * curSegLen;

  // Calculate total path length
  let totalLen = distAlong + (1.0 - bestT) * curSegLen;
  for (let i = bestSeg + 1; i < points.length - 1; i++) {
    totalLen += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }

  const remaining = Math.max(0, totalLen - distAlong);

  res.nearestPoint.x = bestQx;
  res.nearestPoint.z = bestQz;
  res.distanceOffPathM = Math.sqrt(minSqDist);
  res.segmentIndex = bestSeg;
  res.segmentT = bestT;
  res.distanceAlongPathM = distAlong;
  res.remainingDistanceM = remaining;

  return res;
}

/**
 * Generates navigation instruction from smoothed path points and projected progress.
 *
 * Rules:
 *  - Under 20 degrees = straight ("Continue N m").
 *  - 20 to 70 degrees = "Turn left in N m" / "Turn right in N m".
 *  - Over 70 degrees = "Turn sharply left in N m" / "Turn sharply right in N m".
 *  - Approaching destination / final stretch: "Arrive in N m".
 *  - Distances rounded to 0.5 m.
 *  - ETA computed at 1.4 m/s.
 *  - Reuses optional `out` object for ZERO heap allocation per frame.
 */
export function generateInstruction(
  points: NavGridPoint[],
  projection: PathProjection,
  totalPathLengthM: number,
  poiName?: string,
  out?: NavigationInstruction
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

  // Arrived condition (within 0.6 m of anchor)
  if (remainingM <= 0.6) {
    res.type = "arrive";
    res.distanceToEventM = remainingM;
    res.text = poiName ? `Arrive at ${poiName}` : `Arrive in ${formatDistance(remainingM)}`;
    return res;
  }

  const numPoints = points.length;
  if (numPoints < 2) {
    res.type = "arrive";
    res.distanceToEventM = remainingM;
    res.text = `Arrive in ${formatDistance(remainingM)}`;
    return res;
  }

  const segIdx = projection.segmentIndex;
  const p1 = points[segIdx];
  const p2 = points[segIdx + 1];
  const curSegLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  const distToNextWaypoint = (1.0 - projection.segmentT) * curSegLen;

  // If this is the final segment leading directly to destination
  if (segIdx >= numPoints - 2) {
    res.type = "arrive";
    res.distanceToEventM = remainingM;
    res.text = `Arrive in ${formatDistance(remainingM)}`;
    return res;
  }

  // Look ahead for the next turn >= 20 degrees
  let distToTurn = distToNextWaypoint;
  let targetTurnAngle = 0;
  let targetIsLeft = false;
  let foundTurn = false;

  for (let i = segIdx; i < numPoints - 2; i++) {
    const ptA = points[i];
    const ptB = points[i + 1];
    const ptC = points[i + 2];

    const dx1 = ptB.x - ptA.x;
    const dz1 = ptB.z - ptA.z;
    const dx2 = ptC.x - ptB.x;
    const dz2 = ptC.z - ptB.z;

    const { angleDeg, isLeft } = computeTurnAngleDeg(dx1, dz1, dx2, dz2);

    if (angleDeg >= 20.0) {
      targetTurnAngle = angleDeg;
      targetIsLeft = isLeft;
      foundTurn = true;
      break;
    }

    // Accumulate distance along straight segments (< 20 degrees)
    const nextSegLen = Math.hypot(ptC.x - ptB.x, ptC.z - ptB.z);
    distToTurn += nextSegLen;
  }

  // If no turns >= 20 deg remain, we are on a straight path to destination
  if (!foundTurn) {
    res.type = "continue";
    res.distanceToEventM = remainingM;
    res.text = `Continue ${formatDistance(remainingM)}`;
    return res;
  }

  res.distanceToEventM = distToTurn;
  res.turnAngleDeg = targetTurnAngle;

  // If the turn is very close (< 0.6 m)
  const formattedDist = formatDistance(distToTurn);

  if (targetTurnAngle <= 70.0) {
    if (targetIsLeft) {
      res.type = "turn-left";
      res.text = `Turn left in ${formattedDist}`;
    } else {
      res.type = "turn-right";
      res.text = `Turn right in ${formattedDist}`;
    }
  } else {
    if (targetIsLeft) {
      res.type = "turn-sharp-left";
      res.text = `Turn sharply left in ${formattedDist}`;
    } else {
      res.type = "turn-sharp-right";
      res.text = `Turn sharply right in ${formattedDist}`;
    }
  }

  return res;
}
