/**
 * jump_math.ts
 * Pure TypeScript math and logic helpers for spatial search and jump transitions.
 * Zero Three.js and Zero DOM dependencies.
 */

import { POI } from "./poi_types";
import { NavGrid } from "../nav/navgrid";

/**
 * Standard cubic ease-in-out function for smooth transitions.
 * Symmetrical, smooth acceleration and deceleration.
 */
export function easeInOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

/**
 * Normalizes an angle in radians to [-PI, +PI].
 */
export function normalizeAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Interpolates between start and target angles along the shortest angular path.
 * Wraps cleanly across -PI / +PI boundaries.
 */
export function interpolateAngleRad(start: number, target: number, t: number): number {
  const clampedT = Math.max(0, Math.min(1, t));
  const diff = normalizeAngleRad(target - start);
  return normalizeAngleRad(start + diff * clampedT);
}

/**
 * Computes camera yaw in radians needed to face from an observer/anchor at (anchorX, anchorZ)
 * toward a target pin at (pinX, pinZ).
 * Convention: Yaw 0 points along -Z (North).
 * Positive yaw turns left (pointing along -X at +PI/2).
 */
export function computeFacingYaw(
  anchorX: number,
  anchorZ: number,
  pinX: number,
  pinZ: number
): number {
  const dx = pinX - anchorX;
  const dz = pinZ - anchorZ;
  if (Math.hypot(dx, dz) < 1e-5) {
    return 0;
  }
  // Camera forward vector at yaw theta is: [ -sin(theta), 0, -cos(theta) ]
  // Matching [dx, 0, dz]: -sin(theta) = dx, -cos(theta) = dz
  return Math.atan2(-dx, -dz);
}

/**
 * DistanceFieldGate:
 * Gates computation of Dijkstra distance fields so they only recompute
 * when the player moves more than `thresholdM` (default 0.5 m) or when forced.
 */
export class DistanceFieldGate {
  private _lastOrigin: { x: number; z: number } | null = null;
  private _cachedField: Float32Array | null = null;
  readonly thresholdM: number;

  constructor(thresholdM = 0.5) {
    this.thresholdM = thresholdM;
  }

  get cachedField(): Float32Array | null {
    return this._cachedField;
  }

  get lastOrigin(): { x: number; z: number } | null {
    return this._lastOrigin;
  }

  shouldRecompute(currentPos: { x: number; z: number }, force = false): boolean {
    if (force || !this._lastOrigin || !this._cachedField) {
      return true;
    }
    const dist = Math.hypot(currentPos.x - this._lastOrigin.x, currentPos.z - this._lastOrigin.z);
    return dist >= this.thresholdM;
  }

  updateField(currentPos: { x: number; z: number }, field: Float32Array): void {
    this._lastOrigin = { x: currentPos.x, z: currentPos.z };
    this._cachedField = field;
  }

  invalidate(): void {
    this._lastOrigin = null;
    this._cachedField = null;
  }
}

/**
 * Extracts a unique, sorted list of categories present in the given POI array.
 */
export function extractCategories(pois: POI[]): string[] {
  const set = new Set<string>();
  for (const p of pois) {
    if (p.category && p.category.trim()) {
      set.add(p.category.trim());
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export interface CategorizedPOIItem {
  poi: POI;
  walkingDistance?: number;
}

/**
 * Filters POIs by category (or all if category is null/empty) and
 * sorts them by walking distance from distanceField, tie-broken by name.
 */
export function filterPOIsByCategory(
  pois: POI[],
  category: string | null,
  distanceField?: Float32Array | null,
  grid?: NavGrid
): CategorizedPOIItem[] {
  const targetCategory = category ? category.toLowerCase().trim() : null;

  const matched = targetCategory
    ? pois.filter((p) => p.category.toLowerCase().trim() === targetCategory)
    : pois.slice();

  const items: CategorizedPOIItem[] = matched.map((poi) => {
    let walkingDist: number | undefined;
    if (distanceField && grid) {
      const cell = grid.worldToCell(poi.anchor.x, poi.anchor.z);
      if (grid.isValidCell(cell.col, cell.row)) {
        const d = distanceField[cell.row * grid.width + cell.col];
        if (isFinite(d)) {
          walkingDist = d;
        }
      }
    }
    return { poi, walkingDistance: walkingDist };
  });

  items.sort((a, b) => {
    if (a.walkingDistance !== undefined && b.walkingDistance !== undefined) {
      if (Math.abs(a.walkingDistance - b.walkingDistance) > 1e-4) {
        return a.walkingDistance - b.walkingDistance;
      }
    } else if (a.walkingDistance !== undefined) {
      return -1;
    } else if (b.walkingDistance !== undefined) {
      return 1;
    }
    return a.poi.name.localeCompare(b.poi.name);
  });

  return items;
}
